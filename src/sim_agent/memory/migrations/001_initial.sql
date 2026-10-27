CREATE TABLE IF NOT EXISTS episodes (
    task_id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL,
    ruleset_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    task_text TEXT NOT NULL,
    outcome TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS episode_scope ON episodes(world_id, ruleset_id, task_type);
CREATE TABLE IF NOT EXISTS skills (
    skill_id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL,
    ruleset_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('candidate', 'verified', 'invalidated')),
    template TEXT NOT NULL,
    dependencies TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_validations (
    skill_id TEXT NOT NULL REFERENCES skills(skill_id),
    scenario_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES episodes(task_id),
    PRIMARY KEY(skill_id, scenario_id),
    UNIQUE(skill_id, task_id)
);
PRAGMA user_version = 1;
