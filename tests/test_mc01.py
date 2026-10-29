"""Focused regression for placement and the first task; no external services."""
import unittest
import json
from sim_agent.domain.validation import validate_step
from sim_agent.domain.constraints import guard_action
from sim_agent.domain.errors import ValidationError,DeadlineExceeded
from sim_agent.evaluation.mc01.grader import grade
from sim_agent.evaluation.mc01.rcon import parse_snbt
from sim_agent.evaluation.mc01.runner import CountedModel
from sim_agent.agents.coordinator import compile_role_output,evidence_aliases,restore_evidence_refs
from sim_agent.domain.goals import GoalVerifier,parse_goal
from types import SimpleNamespace
from sim_agent.domain.contracts import WORKER_FIELDS,parse_proposal

class MC01Tests(unittest.TestCase):
    def test_cumulative_goal_uses_confirmed_actions_and_deduplicates_recovery(self):
        step=SimpleNamespace(op="act",args={"kind":"collect"},status="succeeded",action_id="action-one",
            result={"effect":{"confirmed_mined_count":10,"inventory_delta":{"minecraft:oak_log":10}}})
        state=SimpleNamespace(steps=[step,step],observation=None)
        goal=parse_goal({"type":"collected_at_least","item":"minecraft:oak_log","count":10})
        result=GoalVerifier().verify(goal,state,observation={"inventory":[]})
        self.assertTrue(result.ok)
        self.assertEqual(result.evidence["collected"],10)
        step.result["effect"]["effect_unknown"]=True
        self.assertFalse(GoalVerifier().verify(goal,state,observation={"inventory":[]}).ok)

    def test_evidence_aliases_do_not_change_requirement_ids_or_report_text(self):
        identifier="evidence-"+"a"*32
        aliases=evidence_aliases({"evidence":[{"id":identifier}]})
        self.assertEqual(aliases[identifier],"E1")
        expanded=restore_evidence_refs({"evidence_refs":["E1"],"requirement_ids":["E1"],"text":"E1"},{"E1":identifier})
        self.assertEqual(expanded["evidence_refs"],[identifier])
        self.assertEqual(expanded["requirement_ids"],["E1"])
        self.assertEqual(expanded["text"],"E1")

    def test_flat_action_compiles_bookkeeping_without_changing_arguments(self):
        flat={"operation":"act","reason":"放置工作台","kind":"place","args":{"item":"minecraft:crafting_table","position":{"x":2,"y":-60,"z":0}},"purpose":"放置"}
        compiled=compile_role_output(json.dumps(flat),"worker",WORKER_FIELDS)
        proposal=parse_proposal(compiled,"worker")
        self.assertEqual(proposal["payload"]["kind"],"place")
        self.assertEqual(proposal["payload"]["args"],flat["args"])
        legacy=json.dumps(proposal)
        self.assertEqual(compile_role_output(legacy,"worker",WORKER_FIELDS),legacy)

    def test_flat_adapter_does_not_repair_unknown_or_malformed_operations(self):
        for raw in ('{"operation":"run_shell","reason":"x"}', '{"operation":"act",',
                    '{"operation":"act","reason":"x","kind":"place","args":{},"purpose":"x","unexpected":true}'):
            self.assertEqual(compile_role_output(raw,"worker",WORKER_FIELDS),raw)
            with self.assertRaises(ValidationError):parse_proposal(raw,"worker")

    def test_place_is_explicit_and_preserves_reserved_stock(self):
        args={"kind":"place","item":"minecraft:crafting_table","position":{"x":2,"y":-60,"z":0}}
        self.assertEqual(validate_step({"op":"act","args":args}).args["kind"],"place")
        with self.assertRaises(ValidationError):
            guard_action({"keep_inventory":{"minecraft:crafting_table":1}},"act",args,{"inventory":[{"name":"minecraft:crafting_table","count":1}]})

    def test_cumulative_logs_may_be_consumed_but_tools_must_be_crafted_and_retained(self):
        tools={"minecraft:wooden_axe":1,"minecraft:wooden_pickaxe":1}
        evidence={"natural_logs_collected":10,"inventory":dict(tools),"crafted":dict(tools),"deaths":0}
        self.assertTrue(grade({},evidence)["success"])
        evidence["crafted"]={}
        self.assertFalse(grade({},evidence)["success"])
        evidence["crafted"]=dict(tools);evidence["natural_logs_collected"]=9
        self.assertFalse(grade({},evidence)["success"])

    def test_server_counter_result_parses(self):
        self.assertEqual(parse_snbt('{inventory:{wooden_axe:1},mined:10,picked:10,deaths:0}')["mined"],10)

class ModelBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_observed_calls_and_retries_share_limit(self):
        class Client:
            async def complete_observed(self,*args):return "done"
        model=CountedModel(Client(),1)
        self.assertEqual(await model.complete_observed([],1,None),"done")
        with self.assertRaises(DeadlineExceeded):await model.complete_observed([],1,None)
