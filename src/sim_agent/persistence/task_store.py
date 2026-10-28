"""Transactional current-task snapshots, action journal and delivery receipts."""
from __future__ import annotations
import json
import sqlite3
import uuid
from pathlib import Path

from sim_agent.domain.errors import ValidationError
from sim_agent.observability.jsonl import utc_now


class TaskStore:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), timeout=5)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
        INSERT OR IGNORE INTO schema_migrations VALUES(1);
        CREATE TABLE IF NOT EXISTS root_tasks(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL, snapshot TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS task_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, root_id TEXT NOT NULL, event TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS action_journal(id TEXT PRIMARY KEY, root_id TEXT NOT NULL, session_id TEXT NOT NULL, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS delivery_parts(report_id TEXT NOT NULL, part_index INTEGER NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(report_id, part_index));
        """)
        self.db.commit()

    def commit_transition(self, expected_revision, event, snapshot):
        root_id = snapshot["root_task_id"]
        with self.db:
            row = self.db.execute("SELECT revision FROM root_tasks WHERE id=?", (root_id,)).fetchone()
            actual = row[0] if row else 0
            if actual != expected_revision:
                raise ValidationError("过期任务状态写入被拒绝")
            revision = actual + 1
            saved = {**snapshot, "revision": revision}
            self.db.execute("INSERT OR REPLACE INTO root_tasks VALUES(?,?,?,?)",
                            (root_id, revision, saved["status"], json.dumps(saved, ensure_ascii=False)))
            cursor = self.db.execute("INSERT INTO task_events(root_id,event) VALUES(?,?)",
                                     (root_id, json.dumps(event, ensure_ascii=False)))
        return revision, cursor.lastrowid

    def read_task(self, root_id):
        row = self.db.execute("SELECT snapshot FROM root_tasks WHERE id=?", (root_id,)).fetchone()
        if not row: raise ValidationError("找不到任务")
        return json.loads(row[0])

    def recent(self, limit=20):
        rows = self.db.execute("SELECT snapshot FROM root_tasks ORDER BY rowid DESC LIMIT ?", (min(20, limit),))
        return [json.loads(r[0]) for r in rows]

    def mark_interrupted(self):
        active = {"received", "interpreting", "planning", "executing", "verifying", "delivering", "cancelling"}
        snapshots=[json.loads(r[0]) for r in self.db.execute("SELECT snapshot FROM root_tasks WHERE status NOT IN ('completed','failed','cancelled','exhausted','superseded')")]
        for snap in snapshots:
            if snap["status"] in active:
                reserved=snap.get("inflight_model_seconds",0)
                if reserved:
                    snap.setdefault("budget",{})["active_seconds"]=snap.get("budget",{}).get("active_seconds",0)+reserved
                    snap["recovery_budget_reservation_charged"]=reserved
                    snap["inflight_model_seconds"]=0
                snap["status"] = "interrupted"
                self.commit_transition(snap["revision"], {"type": "recovery_required", "ts": utc_now()}, snap)

    def journal(self, root_id, session_id, record, journal_id=None):
        journal_id = journal_id or "journal-" + uuid.uuid4().hex
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO action_journal VALUES(?,?,?,?)",
                            (journal_id, root_id, session_id, json.dumps(record, ensure_ascii=False)))
        return journal_id

    def actions(self, root_id):
        rows = self.db.execute("SELECT id,session_id,record FROM action_journal WHERE root_id=? ORDER BY rowid", (root_id,))
        return [{"id": r[0], "session_id": r[1], **json.loads(r[2])} for r in rows]

    def part_status(self, report_id, index):
        row = self.db.execute("SELECT status FROM delivery_parts WHERE report_id=? AND part_index=?", (report_id, index)).fetchone()
        return row[0] if row else None

    def save_part(self, report_id, index, status, text):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO delivery_parts VALUES(?,?,?,?)", (report_id,index,status,text))

    def close(self):
        self.db.close()
