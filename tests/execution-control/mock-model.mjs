// Deterministic model for the real Web/tool relay regression. No network outside its preview.
import http from "node:http";
const port=Number(process.env.PORT||4012);
const textOf=m=>typeof m.content==="string"?m.content:(m.content||[]).map(x=>x.text||"").join("");
const calls=[];
function plan(messages){
  const main=messages.findLastIndex(m=>m.role==="user"&&/EXEC_ONCE|EXEC_STOP|EXEC_READ|EXEC_RECOVER/.test(textOf(m)));
  const first=main<0?"":textOf(messages[main]);
  const tag=messages.filter(m=>m.role==="user").map(textOf).join(" ").match(/RUN_TAG=([a-z0-9]+)/)?.[1]||"default";
  const dir="execution_control_probe_"+tag;
  const tail=messages.slice(main+1);
  const tools=tail.filter(m=>m.role==="tool");
  const extras=tail.filter(m=>m.role==="user").map(textOf);
  if(tools.length)return {text:`${first.includes("EXEC_ONCE")?"EXEC_ONCE_OK":first.includes("EXEC_STOP")?"EXEC_STOP_DONE":first.includes("EXEC_READ")?"EXEC_READ_OK":"RECOVERY_OK"} ${extras.join(" ")}\n${tools.map(textOf).join("\n")}`};
  if(first.includes("EXEC_ONCE"))return {command:`mkdir -p ${dir}; printf 'RUN\\n' >> ${dir}/once.log; printf ONCE_STARTED; sleep 3; printf ONCE_DONE; wc -l ${dir}/once.log`};
  if(first.includes("EXEC_STOP"))return {command:`mkdir -p ${dir}; printf 'START\\n' >> ${dir}/stop.log; printf STOP_STARTED; (sleep 6; printf 'DONE\\n' >> ${dir}/stop.log) & wait`};
  if(first.includes("EXEC_READ"))return {command:`printf 'ONCE_LOG\\n'; cat ${dir}/once.log; printf 'STOP_LOG\\n'; cat ${dir}/stop.log`};
  if(first.includes("EXEC_RECOVER"))return {command:"printf RECOVERY_OK"};
  return {text:"READY for execution-control regression."};
}
http.createServer(async(req,res)=>{
  if(req.method==="GET"){
    res.setHeader("content-type","application/json");
    return res.end(JSON.stringify(req.url==="/calls"?calls:{data:[{id:"mock-execution-control",object:"model"}]}));
  }
  let body="";for await(const chunk of req)body+=chunk;
  const input=JSON.parse(body||"{}");
  const reply=plan(input.messages||[]);
  calls.push({at:new Date().toISOString(),users:(input.messages||[]).filter(m=>m.role==="user").map(textOf),toolResultCount:(input.messages||[]).filter(m=>m.role==="tool").length,command:reply.command});
  const id="chatcmpl-"+crypto.randomUUID();
  if(!input.stream){res.setHeader("content-type","application/json");return res.end(JSON.stringify({id,object:"chat.completion",model:"mock-execution-control",choices:[{index:0,message:{role:"assistant",content:"执行控制测试"},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));}
  res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache"});
  const base={id,object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model:"mock-execution-control"};
  const emit=(delta,finish=null)=>res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta,finish_reason:finish}]})+"\n\n");
  emit({role:"assistant",content:""});
  // Leave a deterministic window to queue the first follow-up before tool dispatch.
  await new Promise(r=>setTimeout(r,1200));
  if(reply.command){emit({content:"我会执行这一次命令。"});emit({tool_calls:[{index:0,id:"call_"+crypto.randomUUID(),type:"function",function:{name:"computer_run_command",arguments:JSON.stringify({command:reply.command,timeoutSec:20})}}]});emit({},"tool_calls");}
  else{emit({content:reply.text});emit({},"stop");}
  res.end("data: [DONE]\n\n");
}).listen(port,"0.0.0.0",()=>console.log("execution-control mock listening on "+port));
