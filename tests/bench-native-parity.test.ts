import { test, expect, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { allocateRun } from "../src/bench/index.ts";
import { executeParityRun, parityEnvironment, parityOrder, parityProtocol, runNativeParity } from "../src/bench/suites/native-parity.ts";
import { controlInputs, PARITY_STORE_SUITE } from "../src/bench/suites/native-parity-fixture.ts";
import { benchBrainYaml, hindsightCost } from "../src/checks/conso.ts";

test("parity dry run resolves three isolated arms and alternates their order without starting a process", async () => {
  const log=spyOn(console,"log").mockImplementation(()=>{});
  try {
    await expect(runNativeParity([])).rejects.toThrow("--allow-paid");
    await runNativeParity(["--dry-run"]);
    const preview=JSON.parse(log.mock.calls.at(-1)![0]);
    expect(preview.protocol.version).toBe("native-parity-1");
    expect(preview.protocol.order).toEqual([["plain","kiba-mem-off","kiba-mem-on"],["kiba-mem-on","kiba-mem-off","plain"]]);
    expect(parityOrder(1)).toEqual(preview.protocol.order[0]);expect(parityOrder(2)).toEqual(preview.protocol.order[1]);
    const [plain,off,on]=preview.arms;
    const settings=(arm:any)=>JSON.parse(arm.argv[arm.argv.indexOf("--settings")+1]);
    expect(plain.argv).not.toContain("--agent");expect(plain.argv).not.toContain("--agents");
    expect(Object.keys(settings(plain))).toEqual(["sandbox","hooks"]);
    // The scope guard is the only hook of plain; the Kiba arms add the lead hooks to it.
    expect(Object.keys(settings(plain).hooks)).toEqual(["PreToolUse"]);
    expect(JSON.stringify(settings(plain).hooks)).toContain("lanes/guard.ts");
    expect(JSON.stringify(settings(plain).hooks)).not.toContain("hooks/hook.ts");
    for(const key of ["ORCH_LEAD","ORCH_HARNESS","ORCH_CONDUCTOR","ORCH_MEMORY"])expect(plain.envKeys).not.toContain(key);
    for(const arm of [off,on]){
      expect(arm.argv[arm.argv.indexOf("--agent")+1]).toBe("kiba");
      expect(settings(arm).hooks.SessionStart.length).toBeGreaterThan(0);
      expect(settings(arm).hooks.Stop.length).toBeGreaterThan(0);
      expect(arm.envKeys).toContain("ORCH_LEAD");expect(arm.envKeys).toContain("ORCH_MEM_SANDBOX");
      // Only the repository path differs in the identical sandbox settings.
      expect({...settings(arm).sandbox,filesystem:undefined}).toEqual({...settings(plain).sandbox,filesystem:undefined});
    }
    const poisoned={ORCH_LEAD:"1",ORCH_HARNESS:"other",ORCH_CONDUCTOR:"kiba",ORCH_MEMORY:"off",ORCH_MEMORY_PROVIDER:"brain",ORCH_BRAIN_CONFIG:"live",ORCH_MEM_SANDBOX:"isolated"};
    expect(parityEnvironment(poisoned,"plain","run","owned")).toEqual({ORCH_MEM_SANDBOX:"isolated",ORCH_BENCH_RUN:"run"});
    expect(parityEnvironment(poisoned,"kiba-mem-off","run","owned").ORCH_MEMORY).toBe("off");
    const enabled=parityEnvironment(poisoned,"kiba-mem-on","run","owned");
    expect(enabled.ORCH_MEMORY).toBeUndefined();expect(enabled.ORCH_BRAIN_CONFIG).toBe("owned");expect(enabled.ORCH_MEMORY_PROVIDER).toBe("hindsight");
    expect(off.envKeys).toContain("ORCH_MEMORY");expect(on.envKeys).not.toContain("ORCH_MEMORY");expect(on.envKeys).toContain("ORCH_BRAIN_CONFIG");
    for(const arm of preview.arms){
      for(const [flag,value] of [["--model","opus"],["--effort","medium"],["--permission-mode","acceptEdits"],["--setting-sources",""],["--mcp-config",'{"mcpServers":{}}'],["--disallowedTools","Agent"],["--max-budget-usd","2"],["--input-format","stream-json"],["--output-format","stream-json"]])expect(arm.argv[arm.argv.indexOf(flag)+1]).toBe(value);
      expect(arm.argv).toContain("--strict-mcp-config");
    }
    await runNativeParity(["--dry-run","--one-pair"]);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).protocol.order).toHaveLength(1);
  } finally {log.mockRestore();}
});

// A real process boundary and real session/prompt hook commands, but no model
// or retain call. The fake server supplies exact per-bank usage counters.
const fakeClaude=String.raw`#!/usr/bin/env bun
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
const argv=process.argv.slice(2),flag=(name)=>argv[argv.indexOf(name)+1];
const settings=JSON.parse(flag("--settings")),plain=!argv.includes("--agent");
const arm=plain?"plain":process.env.ORCH_MEMORY==="off"?"kiba-mem-off":"kiba-mem-on";
await fetch("__HINDSIGHT_URL__/fake-usage/arm/"+arm,{method:"POST"});
const session=flag(argv.includes("--resume")?"--resume":"--session-id");
const message=JSON.parse((await Bun.stdin.text()).trim()).message.content[0].text;
assert(!message.includes("Memory is disabled."));
// Plain keeps only the benchmark's scope guard, never an orch lead hook.
if(plain){assert.deepEqual(Object.keys(settings.hooks),["PreToolUse"]);assert(!JSON.stringify(settings.hooks).includes("hooks/hook.ts"));assert(!process.env.ORCH_LEAD);}
else{
  assert.equal(process.env.ORCH_LEAD,"1");
  for(const [file,size] of [["USER.md",1375],["MEMORY.md",2200]])assert.equal(readFileSync(join(process.env.ORCH_STATE,"kiba-memory",file),"utf8").length,size);
}
const input={session_id:session,cwd:process.cwd(),source:argv.includes("--resume")?"resume":"startup",prompt:message};
for(const event of ["SessionStart","UserPromptSubmit"]){
  for(const entry of settings.hooks?.[event]??[]){
    if(event==="SessionStart"&&entry.matcher!==input.source)continue;
    for(const hook of entry.hooks){
      // Route even accidental memory-off requests to the fake server.
      const env={...process.env,ORCH_BRAIN_CONFIG:process.env.ORCH_BRAIN_CONFIG??__HINDSIGHT_CONFIG__};
      const p=Bun.spawn(["/bin/sh","-c",hook.command],{env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
      p.stdin.write(JSON.stringify(input));p.stdin.end();
      const [output,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
      assert.equal(code,0,stderr);
      if(event==="SessionStart"&&input.source==="startup")assert(output.includes("USER.md:")&&output.includes("MEMORY.md:"));
    }
  }
}
if(process.env.ORCH_BRAIN_CONFIG){
  assert(!process.env.ORCH_MEMORY);
  const config=readFileSync(process.env.ORCH_BRAIN_CONFIG,"utf8");assert(config.includes("retain: true"));
  const bank=config.match(/bank: (bench-parity-[a-f0-9-]+)/)[1];
  const url=config.match(/url: (http:\/\/[^\s]+)/)[1];
  await fetch(url+"/fake-usage/"+bank+"-repo",{method:"POST"});
}else if(!plain)assert.equal(process.env.ORCH_MEMORY,"off");
console.log(JSON.stringify({type:"system",subtype:"init",model:"fake-opus",session_id:session}));
const source=String.raw` + "`" + String.raw`
function parse(text,delimiter,multi){
  if(delimiter.length!==1)throw new Error("invalid delimiter");
  if(multi&&!text.length)return [];
  const rows=[];let fields=[],field="",quoted=false,ended=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];ended=false;
    if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(!quoted&&c===delimiter){fields.push(field);field="";}
    else if(!quoted&&multi&&(c==="\n"||c==="\r")){
      if(c==="\r"&&text[i+1]==="\n")i++;
      fields.push(field);rows.push(fields);fields=[];field="";ended=true;
    }else field+=c;
  }
  if(quoted)throw new Error("unclosed quotes");
  if(!ended){fields.push(field);rows.push(fields);}
  return rows;
}
export function parseLine(line,delimiter=","){return parse(line,delimiter,false)[0];}
` + "`" + String.raw`;
writeFileSync("src/csv.ts",source+(message.includes("Extend the delivered CSV")?'export function parseDocument(text,delimiter=","){return parse(text,delimiter,true);}\n':""));
console.log(JSON.stringify({type:"result",session_id:session,is_error:false,model_usage_since_last_result:{"fake-opus":{costUSD:0.1,outputTokens:5,inputTokens:10,cacheReadInputTokens:20,cacheCreationInputTokens:2}}}));
`;

type SeenRequest={method:string;path:string;arm?:string};
async function fakeRun(mode:"healthy"|"unhealthy"|"provision-failure",check:(root:string,out:string,seen:SeenRequest[])=>void) {
  const root=mkdtempSync("/tmp/orch-parity-test-");
  const keys=["HOME","ORCH_STATE","PATH","CLAUDE_CONFIG_DIR","ORCH_ENV_FILE"];
  const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]])),exitCode=process.exitCode??0;
  const seen:SeenRequest[]=[],usage=new Map<string,number>();let arm:string|undefined,provisioned=0;
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
    const url=new URL(req.url),path=url.pathname;
    if(path.startsWith("/fake-usage/arm/"))arm=path.split("/").at(-1);
    seen.push({method:req.method,path,...(arm?{arm}:{})});
    if(path==="/health")return mode==="unhealthy"?new Response("offline",{status:503}):Response.json({status:"ok"});
    if(path.startsWith("/fake-usage/")){const bank=path.split("/").at(-1)!;usage.set(bank,(usage.get(bank)??0)+1);return Response.json({ok:true});}
    if(req.method==="PUT")return mode==="provision-failure"&&++provisioned===2?new Response("refused",{status:500}):Response.json({});
    if(req.method==="DELETE")return new Response(null,{status:204});
    if(path.endsWith("/operations"))return Response.json({total:0});
    if(path.endsWith("/memories/recall"))return Response.json({results:[]});
    if(path.endsWith("/llm-requests/stats")){
      const count=usage.get(path.split("/")[4])??0;
      const tokens=url.searchParams.get("call_type")==="llm"?{input:1000*count,output:100*count,cached:100*count}:{input:500*count,output:0,cached:0};
      return Response.json({buckets:[{time:"2026-11-03T00:00:00Z",total:count,tokens}]});
    }
    // No hook may retain during these offline tests.
    throw new Error(`unexpected fake Hindsight request ${req.method} ${path}`);
  }});
  try {
    for(const dir of ["home","bin","credentials"])mkdirSync(join(root,dir));
    writeFileSync(join(root,"bin/claude"),fakeClaude.replace("__HINDSIGHT_URL__",`http://127.0.0.1:${server.port}`).replace("__HINDSIGHT_CONFIG__",JSON.stringify(join(root,"fallback-brain.yaml"))),{mode:0o755});
    writeFileSync(join(root,"credentials/.credentials.json"),"{}");writeFileSync(join(root,"empty.env"),"");
    Object.assign(process.env,{HOME:join(root,"home"),ORCH_STATE:join(root,"state"),PATH:join(root,"bin")+":"+saved.PATH,CLAUDE_CONFIG_DIR:join(root,"credentials"),ORCH_ENV_FILE:join(root,"empty.env")});
    const protocol=parityProtocol(1);
    const run=allocateRun({suite:PARITY_STORE_SUITE,feature:"native-parity-1",root:join(root,"bench"),source:{revision:"fake",dirtyHash:null},corpus:"fake CSV",settings:protocol,protocol,models:["fake-opus"],paid:false});
    const brain=readFileSync(join(import.meta.dir,"../catalog/brain.yaml"),"utf8").replace("http://127.0.0.1:8899",`http://127.0.0.1:${server.port}`);
    writeFileSync(join(root,"fallback-brain.yaml"),benchBrainYaml(brain,"bench-parity-disabled","retain=true"));
    await executeParityRun(run,protocol,brain);
    check(root,run.outDir,seen);
  } finally {
    server.stop(true);process.exitCode=exitCode;
    for(const key of keys)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
    // Runs are intentionally sealed read-only; unlock only this test's tree.
    const unlock=(path:string)=>{chmodSync(path,0o700);for(const entry of readdirSync(path,{withFileTypes:true}))if(entry.isDirectory())unlock(join(path,entry.name));};
    unlock(root);rmSync(root,{recursive:true,force:true});
  }
}

test("full fake parity run verifies and publishes every revision, counts Hindsight and hook bytes, and drops exactly its banks", async () => {
  await fakeRun("healthy",(_root,out,seen)=>{
    const rows=JSON.parse(readFileSync(join(out,"evidence.json"),"utf8"));
    expect(rows.map((r:any)=>r.arm)).toEqual(parityOrder(1));
    for(const row of rows){
      expect(row.error).toBeUndefined();expect(row.verifiedRevisions).toBe(3);expect(row.publications).toBe(3);expect(row.receipts).toHaveLength(6);
      expect(row.cliUsd).toBeCloseTo(0.3);expect(row.outputTokens).toBe(15);expect(row.cacheReadInputTokens).toBe(60);expect(row.cacheCreationInputTokens).toBe(6);
      expect(row.seconds*1000).toBeCloseTo(row.nativeMs+row.verifyMs+row.coordinationMs);
      expect(row.cleanup.live).toEqual([]);
      const receipts=row.receipts.filter((r:any)=>r.results);expect(new Set(receipts.map((r:any)=>r.session)).size).toBe(1);
      if(row.arm!=="plain"){
        const path=join(out,row.tag,"orch-state/hooks/bench-receipts.jsonl");expect(existsSync(path)).toBe(true);
        const hooks=readFileSync(path,"utf8").trim().split("\n").map(line=>JSON.parse(line));
        for(const event of ["session-start","prompt-submit"])expect(row.hookContextBytes[event]).toBe(hooks.filter(h=>h.event===event).reduce((n,h)=>n+h.contextBytes,0));
        expect(row.hookContextBytes["session-start"]).toBeGreaterThan(3575);
      }else expect(row.hookContextBytes).toEqual({});
    }
    const on=rows[2];
    expect(on.hindsightTokens).toEqual({llm_calls:3,llm_input:3000,llm_cached:300,llm_output:300,embed_calls:3,embed_tokens:1500});
    expect(on.hindsightUsd).toBeCloseTo(hindsightCost(on.hindsightTokens));expect(on.hindsightUsd).toBeGreaterThan(0);
    expect(on.cost).toBeCloseTo(on.cliUsd+on.hindsightUsd);
    expect(rows[0].cost).toBeCloseTo(rows[0].cliUsd);expect(rows[1].cost).toBeCloseTo(rows[1].cliUsd);
    const created=seen.filter(r=>r.method==="PUT").map(r=>r.path).sort(),dropped=seen.filter(r=>r.method==="DELETE").map(r=>r.path).sort();
    expect(created).toHaveLength(2);expect(dropped).toEqual(created);expect(created.every(path=>path.includes("/bench-parity-"))).toBe(true);
    expect(seen[0].path).toBe("/health");expect(seen.some(r=>r.path.endsWith("/memories"))).toBe(false);
    const hookRequests=seen.filter(r=>r.path!=="/health"&&!r.path.startsWith("/fake-usage/")&&!r.path.endsWith("/llm-requests/stats")&&!r.path.endsWith("/operations")&&!(["PUT","DELETE"].includes(r.method)&&/^\/v1\/default\/banks\/[^/]+$/.test(r.path)));
    expect(hookRequests.length).toBeGreaterThan(0);
    expect([...new Set(hookRequests.map(r=>r.arm))]).toEqual(["kiba-mem-on"]);
    expect(hookRequests.filter(r=>r.arm==="kiba-mem-off")).toEqual([]);
    const metrics=JSON.parse(readFileSync(join(out,"metrics.json"),"utf8"));
    expect(metrics.observations).toHaveLength(3);expect(metrics.observations.every((o:any)=>o.caseId==="native-parity"&&o.quality===1&&o.attempt===1)).toBe(true);
    expect(JSON.parse(readFileSync(join(out,"manifest.json"),"utf8")).artifacts.length).toBeGreaterThan(20);
  });
},120000);

test("parity quality and publication counts follow the declared control input count",async()=>{
  const late=controlInputs.pop()!;
  try{await fakeRun("healthy",(_root,out)=>{
    const metrics=JSON.parse(readFileSync(join(out,"metrics.json"),"utf8"));
    expect(metrics.observations).toHaveLength(3);expect(metrics.observations.every((o:any)=>!o.error&&o.quality===1)).toBe(true);
    expect(JSON.parse(readFileSync(join(out,"runtime-models.json"),"utf8")).complete).toBe(true);
  });}finally{controlInputs.push(late);}
},120000);

test("an unhealthy Hindsight fails the memory arm before any Claude process or bank is started", async () => {
  await fakeRun("unhealthy",(_root,out,seen)=>{
    const rows=JSON.parse(readFileSync(join(out,"evidence.json"),"utf8"));
    expect(rows).toHaveLength(1);expect(rows[0].arm).toBe("kiba-mem-on");expect(rows[0].error).toContain("preflight failed");expect(rows[0].receipts).toEqual([]);
    expect(seen).toEqual([{method:"GET",path:"/health"}]);expect(readdirSync(out).some(name=>name.startsWith("1-"))).toBe(false);
  });
},10000);

test("failed bank provisioning still drops every claimed bank and seals the failed case", async () => {
  await fakeRun("provision-failure",(_root,out,seen)=>{
    const rows=JSON.parse(readFileSync(join(out,"evidence.json"),"utf8"));
    expect(rows[2].error).toContain("bank provisioning failed");expect(rows[2].receipts).toEqual([]);
    expect(seen.some(r=>r.path.endsWith("/operations")||r.path.endsWith("/llm-requests/stats"))).toBe(false);
    expect(rows[2].hindsightTokens).toBeNull();expect(rows[2].hindsightUsd).toBeNull();
    expect(seen.filter(r=>r.method==="PUT")).toHaveLength(2);
    expect(seen.filter(r=>r.method==="DELETE")).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(out,"bank-cleanup.json"),"utf8"))[0].banks).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(out,"metrics.json"),"utf8")).observations[2].quality).toBe(0);
  });
},120000);
