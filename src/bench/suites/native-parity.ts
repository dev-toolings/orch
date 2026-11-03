// native-parity: plain Claude Code versus native Kiba, with living memory as a
// separate axis. The permanent native non-regression bench (baseline
// native-parity-1); the POC suites it grew from live on `archive/benches`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allocateRun, fingerprint, type BenchObservation, type BenchRun } from "../index.ts";
import { ROOT } from "../../core/profile.ts";
import { projectKey } from "../../core/project.ts";
import { benchBrainYaml, drainOwnedBanks, dropOwnedBanks, exactOwnedBankUsage, hindsightCost, PRICES_VERSION, type HindsightUsage } from "../../checks/conso.ts";
import { ensureBank, health, loadHindsightConfig, type HindsightConfig } from "../../memory/hindsight.ts";
import type { JobReceipt } from "../../core/tasks.ts";
import { cleanupParityCase, controlInputs, nativeControlHistory, nativeStep, parityArgv, PARITY_STORE_SUITE, prepareParityCase, startDelivery, verifyStep, waitFor, type ParityCase } from "./native-parity-fixture.ts";

export const parityArms = ["plain", "kiba-mem-off", "kiba-mem-on"] as const;
export type ParityArm = typeof parityArms[number];
export const parityOrder = (repetition:number):ParityArm[] => repetition % 2 ? [...parityArms] : [...parityArms].reverse();

export function parityProtocol(repetitions:number) {
  return {
    version:"native-parity-1", repetitions, arms:parityArms,
    order:Array.from({length:repetitions},(_,i)=>parityOrder(i+1)), lead:"opus/medium", permissionMode:"acceptEdits",
    additions:{plain:"Claude Code with sandbox settings only; no named agent or orch hooks",
      "kiba-mem-off":"nativeKibaArgv, lifecycle hooks, scope guard, synthetic USER.md (1375 characters) and MEMORY.md (2200 characters); living memory off",
      "kiba-mem-on":"same native Kiba plus Hindsight recall and retain in fresh owned operator and project banks; catalog recall limits"},
    workload:"controlInputs: request, clarification, late comment; same files, public tests, hidden acceptance and local publication for all three revisions",
    transport:"one stream-json claude -p process per revision, resumed on the same session id; identical driver prompt in every arm",
    counted:["per-result CLI estimated USD deltas, including injected context", "exact owned-bank Hindsight tokens and estimated USD at conso pricing", "execution, verification and residual coordination wall time"],
    notCounted:["subscription invoice", "provider latency variance", "bank provisioning, queue drain and cleanup time"],
    pricingVersion:PRICES_VERSION,
    acceptance:`same quality (verified revisions / ${controlInputs.length}), no higher total estimated cost, no slower case response than plain`,
    limitations:["small synthetic CSV workload and at most two repetitions do not establish universal parity", "fresh memory banks measure within-case learning, not a pre-existing personal memory corpus", "synthetic profile content matches production sizes, not operator data", "cache state and provider latency are observed, not controlled", "driver owns sequential events, verification and loopback delivery; no production external service or live interruption"],
  };
}

// The base environment is already an allowlist from prepareParityCase.
export function parityEnvironment(base:Record<string,string>,arm:ParityArm,runId:string,brainPath:string):Record<string,string> {
  const env:Record<string,string>={...base,ORCH_BENCH_RUN:runId};
  for(const key of ["ORCH_LEAD","ORCH_HARNESS","ORCH_CONDUCTOR","ORCH_MEMORY","ORCH_MEMORY_PROVIDER","ORCH_BRAIN_CONFIG"])delete env[key];
  if(arm!=="plain")Object.assign(env,{ORCH_LEAD:"1",ORCH_HARNESS:"claude",ORCH_CONDUCTOR:"native"});
  if(arm==="kiba-mem-off")env.ORCH_MEMORY="off";
  if(arm==="kiba-mem-on")Object.assign(env,{ORCH_BRAIN_CONFIG:brainPath,ORCH_MEMORY_PROVIDER:"hindsight"});
  return env;
}

function syntheticProfiles(state:string):void {
  const dir=join(state,"kiba-memory");mkdirSync(dir,{recursive:true});
  const texts={"USER.md":[1375,"The developer prefers concise English explanations and small focused changes. Preserve public contracts, inspect existing code, use the repository toolchain, and report concrete verification evidence. Ask when a requirement is ambiguous. Keep private information out of examples. "],
    "MEMORY.md":[2200,"Project decisions: keep implementation modules focused and interfaces explicit. Verify behavior with deterministic local fixtures. Preserve existing contracts when extending a module. Document assumptions and limitations. Use isolated state for experiments and keep reproducible evidence of each revision. "]} as const;
  for(const [file,[size,text]] of Object.entries(texts))writeFileSync(join(dir,file),text.repeat(Math.ceil(size/text.length)).slice(0,size-1)+"\n");
}

type NativeReceipt = Awaited<ReturnType<typeof nativeStep>>;
interface ParityResult {
  tag:string; arm:ParityArm; repetition:number; seconds:number; cost:number|null; cliUsd:number|null;
  nativeMs:number; verifyMs:number; coordinationMs:number; receipts:(JobReceipt & {results?:any[]})[];
  verifiedRevisions:number; publications:number; publicationReceipts:unknown[];
  outputTokens?:number; inputTokens?:number; cacheReadInputTokens?:number; cacheCreationInputTokens?:number;
  hookContextBytes:Record<string,number>; hindsightTokens:HindsightUsage|null; hindsightUsd:number|null;
  error?:string; cleanup?:unknown;
}

function summarizeReceipts(row:ParityResult):void {
  const native=row.receipts.filter((r):r is NativeReceipt=>!!r.results);
  row.cliUsd=native.length&&native.every(r=>r.costComplete&&typeof r.cost==="number")?native.reduce((sum,r)=>sum+r.cost!,0):null;
  row.cost=row.cliUsd===null||row.hindsightUsd===null?null:row.cliUsd+row.hindsightUsd;
  row.nativeMs=native.reduce((sum,r)=>sum+(r.elapsedMs??0),0);
  row.verifyMs=row.receipts.filter(r=>r.sha).reduce((sum,r)=>sum+(r.elapsedMs??0),0);
  row.coordinationMs=row.seconds*1000-row.nativeMs-row.verifyMs;
  const deltas=native.flatMap(r=>r.results.flatMap(result=>Object.values(result.model_usage_since_last_result??{}))) as Record<string,unknown>[];
  for(const key of ["outputTokens","inputTokens","cacheReadInputTokens","cacheCreationInputTokens"] as const){
    const counts=deltas.map(d=>d[key]).filter((n):n is number=>typeof n==="number"&&Number.isFinite(n));
    if(counts.length)row[key]=counts.reduce((sum,n)=>sum+n,0);
  }
}

async function executeCase(c:ParityCase,row:ParityResult):Promise<void> {
  writeFileSync(join(c.config.deliveryRoot,"ack-open"),"open\n");
  startDelivery(c);
  const session=randomUUID();
  for(let revision=1;revision<=controlInputs.length;revision++){
    const dir=join(c.root,"control",`revision-${revision}`);mkdirSync(dir,{recursive:true});
    const receipt=await nativeStep(c.config,{id:"ticket-1",session,sessionStarted:revision>1,attempt:revision*2-1,files:c.config.files},nativeControlHistory(revision),join(dir,"execute"),{plain:row.arm==="plain",memoryInstruction:""});
    row.receipts.push(receipt);assert.equal(receipt.ok,true,receipt.error??"native execution failed");
    const verified=await verifyStep(c.config,`ticket-1-r${revision}-verify-${revision*2}`,revision===3,join(dir,"verify"));
    row.receipts.push(verified);row.verifiedRevisions++;
    const address=await waitFor(()=>existsSync(join(c.config.deliveryRoot,"address.json"))&&JSON.parse(readFileSync(join(c.config.deliveryRoot,"address.json"),"utf8")));
    const id=`ticket-1-r${revision}-${verified.sha!.slice(0,16)}`;
    const response=await fetch(address.url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id,task:"ticket-1",revision,sha:verified.sha}),signal:AbortSignal.timeout(2000)});
    assert.equal(response.ok,true,"local publication failed");row.publicationReceipts.push(await response.json());row.publications++;
  }
  assert.equal(existsSync(join(c.config.root,"state.json")),false,"parity arms must not acquire a durable task journal");
  const remote=JSON.parse(readFileSync(join(c.config.deliveryRoot,"effects.json"),"utf8"));
  assert.equal(Object.keys(remote).length,controlInputs.length);
}

function copyTree(run:BenchRun,path:string,prefix:string):void {
  if(!existsSync(path))return;
  for(const entry of readdirSync(path,{withFileTypes:true})){
    const next=join(path,entry.name),name=`${prefix}/${entry.name}`;
    if(entry.isDirectory())copyTree(run,next,name);
    else if(entry.isFile())run.writeArtifact(name,readFileSync(next));
  }
}

// Public driver for offline fake-process tests. The CLI's paid gate is below.
export async function executeParityRun(run:BenchRun,protocol:ReturnType<typeof parityProtocol>,brainSource:string):Promise<void> {
  const evidence:ParityResult[]=[],observations:BenchObservation[]=[];
  const owned:{config:HindsightConfig;banks:string[];row:ParityResult;provisioned:boolean}[]=[];
  run.writeJsonArtifact("protocol.json",protocol);run.writeJsonArtifact("corpus.json",controlInputs);
  for(const file of ["native-parity.ts","native-parity-fixture.ts"])run.writeArtifact(`source/${file}`,readFileSync(join(import.meta.dir,file)));
  run.writeArtifact("source/kiba-native.md",readFileSync(join(ROOT,"catalog/kiba-native.md")));
  const newRow=(arm:ParityArm,repetition:number):ParityResult=>({tag:`${repetition}-${arm}`,arm,repetition,seconds:0,cost:null,cliUsd:null,nativeMs:0,verifyMs:0,coordinationMs:0,receipts:[],verifiedRevisions:0,publications:0,publicationReceipts:[],hookContextBytes:{},hindsightTokens:null,hindsightUsd:arm==="kiba-mem-on"?null:0});
  try{
    // Fail before spending on any arm if the memory comparator cannot run.
    const preflightRoot=mkdtempSync(join(tmpdir(),"orch-parity-preflight-"));
    try{
      const path=join(preflightRoot,"brain.yaml");writeFileSync(path,benchBrainYaml(brainSource,"bench-parity-preflight","retain=true"));
      const ready=await health(loadHindsightConfig(path));
      if(!ready.ok){const row=newRow("kiba-mem-on",1);row.error=`Hindsight preflight failed: ${ready.error}`;evidence.push(row);process.exitCode=1;return;}
    }catch(error){
      const row=newRow("kiba-mem-on",1);row.error=`Hindsight preflight failed: ${String(error)}`;evidence.push(row);process.exitCode=1;return;
    }finally{rmSync(preflightRoot,{recursive:true,force:true});}
    experiment:for(let repetition=1;repetition<=protocol.repetitions;repetition++)for(const arm of parityOrder(repetition)){
      const row=newRow(arm,repetition);evidence.push(row);
      const root=mkdtempSync(join(tmpdir(),"orch-native-parity-"));let c:ParityCase|undefined;
      let owner:typeof owned[number]|undefined;
      const fail=(error:unknown)=>{row.error=[row.error,String(error)].filter(Boolean).join("; ");};
      try{
        c=prepareParityCase(root,3000);
        const brainPath=join(root,"brain.yaml");
        c.config.env=parityEnvironment(c.config.env,arm,run.id,brainPath);
        if(process.env.ORCH_ENV_FILE)c.config.env.ORCH_ENV_FILE=process.env.ORCH_ENV_FILE;
        if(arm!=="plain"){
          syntheticProfiles(c.config.env.ORCH_STATE);
          // Production hooks resolve their entry through this isolated HOME.
          symlinkSync(join(ROOT,"src/orch.ts"),join(c.config.home,".local/bin/orch"));
        }
        if(arm==="kiba-mem-on"){
          const bank=`bench-parity-${randomUUID()}`;
          const yaml=benchBrainYaml(brainSource,bank,"retain=true");writeFileSync(brainPath,yaml);
          const config=loadHindsightConfig(brainPath),banks=[bank,`${bank}-${projectKey(c.config.repo)}`];
          owner={config,banks,row,provisioned:false};owned.push(owner);
          const ready=await health(config);if(!ready.ok)throw new Error(`Hindsight unavailable: ${ready.error}`);
          for(const bank of banks){const ensured=await ensureBank(config,bank);if(!ensured.ok)throw new Error(`bank provisioning failed: ${ensured.error}`);}
          owner.provisioned=true;
          run.writeArtifact(`${row.tag}/brain.yaml`,yaml);run.writeJsonArtifact(`${row.tag}/owned-banks.json`,banks);
        }
        writeFileSync(c.path,JSON.stringify(c.config,null,2)+"\n",{mode:0o600});
        run.writeJsonArtifact(`${row.tag}/contract.json`,{files:c.config.files,publicTests:c.config.publicTests,verifyDelayMs:c.config.verifyDelayMs});
        console.log(`${row.tag}: starting`);
        const start=Date.now();
        try{await executeCase(c,row);}finally{row.seconds=(Date.now()-start)/1000;}
      }catch(error){fail(error);}
      finally{
        try{
          if(c){
            try{row.cleanup=await cleanupParityCase(c);}catch(error){fail(error);}
            if(owner?.provisioned){
              try{
                const base=owner.config.url.replace(/\/$/,"");
                if(await drainOwnedBanks(base,owner.banks))throw new Error("Hindsight queue did not drain; cost incomplete");
                row.hindsightTokens=await exactOwnedBankUsage(base,owner.banks);row.hindsightUsd=hindsightCost(row.hindsightTokens);
              }catch(error){fail(error);}
            }
            const path=join(c.config.env.ORCH_STATE,"hooks/bench-receipts.jsonl");
            if(existsSync(path))for(const line of readFileSync(path,"utf8").split("\n").filter(Boolean)){
              const receipt=JSON.parse(line);assert.equal(receipt.run,run.id);
              assert(Number.isFinite(receipt.contextBytes)&&receipt.contextBytes>=0);
              row.hookContextBytes[receipt.event]=(row.hookContextBytes[receipt.event]??0)+receipt.contextBytes;
            }
            if(arm!=="plain"&&(!("session-start" in row.hookContextBytes)||!("prompt-submit" in row.hookContextBytes)))fail("missing lifecycle hook receipts");
            copyTree(run,c.config.root,`${row.tag}/runtime`);copyTree(run,join(root,"control"),`${row.tag}/control`);
            copyTree(run,c.config.deliveryRoot,`${row.tag}/remote`);copyTree(run,c.config.env.ORCH_STATE,`${row.tag}/orch-state`);
            for(const file of c.config.files)run.writeArtifact(`${row.tag}/final/${file}`,readFileSync(join(c.config.repo,file)));
          }
        }catch(error){fail(error);}
        finally{rmSync(root,{recursive:true,force:true});summarizeReceipts(row);}
      }
      console.log(`${row.tag}: ${row.error??"PASS"}, cost=${row.cost??"unknown"}, seconds=${row.seconds}`);
      if(row.error){process.exitCode=1;break experiment;}
    }
  }finally{
    const cleanup:unknown[]=[];
    for(const owner of owned){
      const result=await dropOwnedBanks(owner.config,owner.banks);cleanup.push({banks:owner.banks,result});
      if(!result.startsWith("oui (")){owner.row.error=[owner.row.error,"owned bank cleanup failed"].filter(Boolean).join("; ");process.exitCode=1;}
    }
    for(const row of evidence)observations.push({caseId:"native-parity",config:row.arm,attempt:row.repetition,quality:row.verifiedRevisions/controlInputs.length,cost:row.cost,latencyMs:row.seconds*1000,...(row.error?{error:row.error}:{})});
    run.writeJsonArtifact("bank-cleanup.json",cleanup);run.writeJsonArtifact("evidence.json",evidence);
    const models=evidence.flatMap(row=>row.receipts.map(receipt=>receipt.model).filter(Boolean));
    run.writeJsonArtifact("runtime-models.json",{complete:evidence.length===protocol.repetitions*parityArms.length&&evidence.every(row=>!row.error&&row.receipts.filter(r=>r.model).length===controlInputs.length),models:[...new Set(models)]});
    run.finalize(observations);
  }
}

export async function runNativeParity(args:string[]):Promise<void> {
  for(const arg of args)if(!["--allow-paid","--dry-run","--one-pair"].includes(arg))throw new Error(`unsupported parity option ${arg}`);
  const dryRun=args.includes("--dry-run"),repetitions=args.includes("--one-pair")?1:2;
  if(!dryRun&&!args.includes("--allow-paid"))throw new Error("native parity requires --allow-paid");
  if(process.platform!=="linux")throw new Error("native parity currently requires Linux");
  const git=(...args:string[])=>{const result=spawnSync("git",["-C",ROOT,...args],{encoding:"utf8",timeout:10000});if(result.status!==0)throw new Error("source snapshot failed");return result.stdout.trim();};
  const paths=git("ls-files","--others","--exclude-standard","-z").split("\0").filter(Boolean).sort();
  const protocol=parityProtocol(repetitions);
  const brainSource=readFileSync(join(ROOT,"catalog/brain.yaml"),"utf8");
  const run=allocateRun({suite:PARITY_STORE_SUITE,feature:"native-parity-1",source:{revision:git("rev-parse","HEAD"),dirtyHash:fingerprint([git("diff","--binary","HEAD"),...paths.map(path=>[path,readFileSync(join(ROOT,path),"utf8")])])},corpus:controlInputs,settings:{protocol,brain:fingerprint(brainSource)},models:["opus/medium"],protocol,paid:!dryRun,dryRun});
  if(dryRun){
    const arms=parityArms.map(arm=>{
      const root=join(tmpdir(),`orch-native-parity-${run.id}`,arm),repo=join(root,"repo");
      const base={HOME:join(root,"home"),PATH:"<isolated HOME>/.local/bin:<PATH>",TMPDIR:join(root,"native-tmp"),ORCH_MEM_SANDBOX:join(root,"memory"),ORCH_STATE:join(root,"orch-state"),ENABLE_CLAUDEAI_MCP_SERVERS:"false",DISABLE_AUTOUPDATER:"1",DISABLE_TELEMETRY:"1",CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1"};
      const env=parityEnvironment(base,arm,run.id,join(root,"brain.yaml"));
      const envKeys=Object.keys(env).sort();
      return {arm,argv:parityArgv({repo},{session:"<same-session-per-case>",sessionStarted:false},{plain:arm==="plain"}),resume:"replace --session-id with --resume on revisions 2 and 3",envKeys,envDiff:{added:envKeys.filter(key=>!(key in base)),unset:["ORCH_LEAD","ORCH_HARNESS","ORCH_CONDUCTOR","ORCH_MEMORY","ORCH_BRAIN_CONFIG","ORCH_MEMORY_PROVIDER"].filter(key=>!(key in env))}};
    });
    console.log(JSON.stringify({id:run.id,protocol,arms},null,2));return;
  }
  await executeParityRun(run,protocol,brainSource);
  console.log(`Saved ${run.outDir}`);
}
