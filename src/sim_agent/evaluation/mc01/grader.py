"""Personal-test scoring from vanilla server counters and final inventory."""
def grade(task,state):
    tools={"minecraft:wooden_axe":1,"minecraft:wooden_pickaxe":1}
    checks=[{"name":"collected_10_logs","observed":state["natural_logs_collected"],"pass":state["natural_logs_collected"]>=10},
        {"name":"crafted_both_tools","observed":{k:state["crafted"].get(k,0) for k in tools},"pass":all(state["crafted"].get(k,0)>=n for k,n in tools.items())},
        {"name":"retained_both_tools","observed":{k:state["inventory"].get(k,0) for k in tools},"pass":all(state["inventory"].get(k,0)>=n for k,n in tools.items())}]
    success=all(check["pass"] for check in checks) and state["deaths"]==0
    return {"success":success,"episode_status":"success" if success else "failed","checks":checks,"deaths":state["deaths"],"invalid_reason":None,"scope":"personal_test"}
