import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {redactContactPii} from './platform/contact-pii-redaction.mjs';
import {postgresPersistenceEnabled} from './persistence/postgres-helpers.mjs';
import {getPostgresAcquisitionSessionStore} from './persistence/postgres-session-store.mjs';
import {createConversationRepository} from './persistence/conversation-repository.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const configuredSqliteFile=String(
  process.env.DEMO_LOCAL_CONVERSATION_SQLITE_FILE||process.env.DEMO_LOCAL_SQLITE_FILE||''
).trim();
// DEMO_LOCAL_CONVERSATION_STORE_FILE is kept only as a path hint so existing
// local and test deployments keep landing on their own database file.  Its
// former JSON content is no longer read or written.
const legacyStorePath=String(process.env.DEMO_LOCAL_CONVERSATION_STORE_FILE||'').trim();
const sqliteFile=configuredSqliteFile
  ? (configuredSqliteFile===':memory:'?':memory:':resolve(root,configuredSqliteFile))
  : legacyStorePath===':memory:'?':memory:'
    : legacyStorePath
      ? resolve(root,legacyStorePath).replace(/\.json$/i,'')+'.sqlite'
      : resolve(root,'.local-data','demo-local.sqlite');
const postgresBackend=postgresPersistenceEnabled();
const repository=postgresBackend?null:createConversationRepository({sqliteFile});
if(!postgresBackend&&!repository){
  throw new Error('Local conversation storage requires node:sqlite (Node 24 or Node 22 with --experimental-sqlite); the JSON backend has been removed');
}
export const localConversationStoreStatus = () => postgresBackend
  ? {driver:'postgres',durable:true,file:null}
  : repository.status();
export const closeLocalConversationStore = () => repository?.close();
const key=(tenant,channel,id)=>createHash('sha256').update(JSON.stringify([tenant,channel,id])).digest('hex').slice(0,20);
// Read-only hydration of the separate acquisition-session file. It is not a
// conversation backend and nothing here ever writes to it.
const readJsonFile=(file)=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return {};throw error;}};
// Match the durable PostgreSQL assistant ID.  The public UI receives this ID
// with the chat response and uses it to reconcile a short presentation reply
// with the canonical history row.
const assistantMessageIdFor=(envelope)=>`reply_${createHash('sha256')
 .update(`${String(envelope.tenant_id||'').trim().toLowerCase()}:${String(envelope.channel||'')}:${String(envelope.conversation_id||'')}\u0000${String(envelope.message?.id||'')}\u0000assistant`)
 .digest('hex')}`;
const cursorFor=(externalId,nextSeq)=>`${String(externalId||'conversation')}#${Math.max(0,Number(nextSeq)||0)}`;
const normalizeMessageMetadata=(row)=>{
 row.messages=Array.isArray(row.messages)?row.messages:[];
 row.nextSeq=Number.isInteger(row.nextSeq)?row.nextSeq:0;
 for(const message of row.messages){
  if(!Number.isInteger(message.seq))message.seq=++row.nextSeq;
  else row.nextSeq=Math.max(row.nextSeq,message.seq);
  if(!message.status)message.status='committed';
 }
 row.cursor=typeof row.cursor==='string'&&row.cursor?row.cursor:cursorFor(row.externalId,row.nextSeq);
 return row;
};
export function recordLocalConversation(envelope,response){
 if(postgresPersistenceEnabled())return;
 const id=key(envelope.tenant_id,envelope.channel,envelope.conversation_id);
 const at=envelope.message.timestamp||new Date().toISOString();
 const requestedStatus=response?.messageStatus || (response?.status==='failed'?'failed':response?.reply?.text?'committed':'processing');
 const reply=response?.reply?.text;
 const messages=[{
  id:String(envelope.message.id),
  status:requestedStatus,
  from:'customer',
  text:redactContactPii(envelope.message.text),
  at,
  ...(response?.error_code?{error_code:String(response.error_code)}:{})
 }];
 if(reply)messages.push({
  id:assistantMessageIdFor(envelope),
  status:'committed',
  from:response.handover?.required?'system':'ai',
  text:redactContactPii(reply),
  at:new Date().toISOString(),
  conflict:'ignore'
 });
 repository.appendMessages(id,{
  tenant:envelope.tenant_id,
  channel:envelope.channel,
  externalId:envelope.conversation_id,
  createdAt:at,
  updatedAt:new Date().toISOString(),
  projects:response.profile_signals?.projects||null,
  messages
 });
}
export function readLocalConversations(tenant){
 if(postgresPersistenceEnabled())return [];
 const records=repository.list(tenant);
 // Recover currently retained pre-upgrade sessions without inferring a tenant.
 const sessionPath=process.env.DEMO_ACQUISITION_SESSION_STORE_FILE;
 if(sessionPath!==':memory:')for(const [id,s] of Object.entries(readJsonFile(resolve(root,sessionPath||'.local-data/acquisition-sessions.json')).sessions||{})){
  const prefix=tenant+':web:';if(!id.startsWith(prefix))continue;const externalId=id.slice(prefix.length);if(records.some(r=>r.channel==='web'&&r.externalId===externalId))continue;
  if(!s.turns?.length)continue;
  records.push(normalizeMessageMetadata({id:key(tenant,'web',externalId),tenant,externalId,channel:'web',projects:s.projects||[],createdAt:new Date(s.createdAt).toISOString(),updatedAt:new Date(s.updatedAt).toISOString(),messages:s.turns.map((t,i)=>({id:id+':'+i,from:t.role==='user'?'customer':'ai',text:redactContactPii(t.content||''),at:t.at||new Date(s.updatedAt).toISOString()}))}));
 }
 return records.map(normalizeMessageMetadata).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0,500);
}
export async function readPersistedConversations(tenant){
 if(postgresPersistenceEnabled())return getPostgresAcquisitionSessionStore().listConversations({tenantId:tenant});
 return readLocalConversations(tenant);
}

export function markLocalConversationDelivery({tenant,externalId,messageId}={}){
 if(postgresPersistenceEnabled())return null;
 if(!tenant||!externalId||!messageId)return null;
 let found=false,replayed=false;
 const row=repository.update(key(tenant,'web',externalId),current=>{
  if(!current)return null;
  normalizeMessageMetadata(current);
  const target=current.messages.find(item=>item.id===messageId&&item.from==='staff');
  if(!target)return null;
  found=true;
  replayed=target.delivery?.delivery_status==='delivered';
  if(!replayed){
   target.delivery={...(target.delivery||{}),submission_status:'submitted',delivery_status:'delivered',delivered_at:target.delivery?.delivered_at||new Date().toISOString(),read_status:'not_reported',channel:'web'};
   current.updatedAt=new Date().toISOString();
  }
  return current;
 });
 if(!found)return null;
 return {message:row.messages.find(item=>item.id===messageId&&item.from==='staff'),replayed};
}

// 匿名访客尚未留资时没有 lead 记录，人工回复必须写进访客历史读取的同一份会话真源，
// 否则管理端会得到 CONVERSATION_NOT_FOUND，前台也永远收不到这条人工消息。
export function appendLocalConversationStaffMessage({tenant,externalId,message}={}){
 if(postgresPersistenceEnabled())return null;
 if(!tenant||!externalId||!message?.id||!message?.text)return null;
 const idempotencyKey=String(message.idempotency_key||'').trim();
 let replayed=false,stored=null;
 const apply=row=>{
  if(!row)return null;
  normalizeMessageMetadata(row);
  const existing=idempotencyKey?row.messages.find(item=>item.from==='staff'&&item.idempotency_key===idempotencyKey):null;
  if(existing){
   if(existing.text!==message.text||existing.actor!==message.actor){
    const error=new Error('同一发送标识不能用于不同的人工回复内容');
    error.code='IDEMPOTENCY_PAYLOAD_MISMATCH';
    error.status=409;
    throw error;
   }
   replayed=true;stored=existing;
   return row;
  }
  stored={...message,seq:++row.nextSeq,status:'committed'};
  row.messages.push(stored);
  row.messages=row.messages.slice(-200);
  row.updatedAt=new Date().toISOString();
  row.cursor=cursorFor(row.externalId,row.nextSeq);
  return row;
 };
 let row=repository.update(key(tenant,'web',externalId),apply);
 if(!row){
  // 老会话可能只存在于 session store，先水合再追加，避免人工回复丢失历史。
  const hydrated=readLocalConversations(tenant).find(item=>item.externalId===externalId)||null;
  if(!hydrated)return null;
  repository.put(hydrated);
  row=repository.update(key(tenant,'web',externalId),apply);
  if(!row)return null;
 }
 return {row,message:stored,replayed};
}

export function localConversationView(row,customer,task){
 const customerId=customer?.id||'C-VISITOR-'+row.id;
 const visitor=customer||{id:customerId,origin:'acquisition_advisor',dataClassification:'production',name:'访客 '+row.id.slice(-6).toUpperCase(),mobile:'未留手机号',source:'在线咨询',firstChannel:'获客顾问 Web',latestChannel:'获客顾问 Web',owner:'未分配',agent:'AI获客顾问·小美',macroStage:'售前',microStage:'在线咨询',stageEnteredAt:row.createdAt,score:0,health:0,photo:null,photoConsent:'未上传',tags:['在线访客','未留资'],interests:(row.projects||[]).map(name=>({name,score:0})),pains:[],itches:[],delights:[],profile:{budget:'待确认',decision:'待确认',contact:'未留资',style:'在线咨询',concern:'',confidence:0},nextAction:{title:'继续在线沟通',reason:'访客正在咨询',guardrail:'未留资不代表授权电话回访'},timeline:[],serviceConsent:'未授权',marketingConsent:'未授权'};
 return {customer:visitor,conversation:{id:'V-LIVE-'+row.id,externalConversationId:row.externalId,customerId,channel:row.channel==='web'?'获客顾问 Web':row.channel,status:task?.status==='pending'?'待人工':task?.status==='claimed'?'人工接待':'进行中',mode:task?.status==='claimed'?'人工':'AI辅助',unread:0,updatedAt:row.updatedAt,cursor:row.cursor||cursorFor(row.externalId,row.nextSeq),lastMessage:row.messages.at(-1)?.text||'',messages:row.messages}};
}
