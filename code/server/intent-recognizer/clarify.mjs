import { resolveTaskCapability } from './action-capability.mjs';
import { resolveCurrentTopic } from './context.mjs';

const RULES={
  price_verification:[[['project','product'],'您想了解哪个项目或产品的价格？']],
  product_attribute_verification:[[['product'],'您问的是哪款产品或假体？']],
  doctor_profile:[[['doctor'],'您想了解哪位医生？']],
  doctor_schedule_verification:[[['doctor'],'您想了解哪位医生？']],
  doctor_comparison:[[['doctor','doctor_2'],'您想比较哪两位医生？']],
  doctor_discovery_by_project:[[['project'],'您想咨询哪个项目方向的医生？']],
  appointment_request:[[['project','doctor'],'您想预约哪个项目或医生？'],[['time_preference'],'您希望哪天、上午还是下午到院面诊？']],
  project_comparison:[[['project','project_2'],'您想比较哪两个项目？']]
};

export function decideClarification(recognition,routerState={},message='') {
  const current=resolveCurrentTopic(routerState,message);
  const slots=recognition.slots || [];
  const has=field=>slots.some(slot=>slot.field===field) || Boolean(current?.[field]);
  const tasks=(recognition.tasks || []).map(task=>{
    let missing=[],question=null;
    if(task.intent==='need_clarification') {missing=[];question='您想了解哪个项目或哪方面的信息？';}
    else for(const [fields,prompt] of RULES[task.intent] || []) {
      if(fields.includes('doctor_2') || fields.includes('project_2')) {
        const base=fields[0];
        const distinct=new Set([...slots.filter(s=>s.field===base).map(s=>s.value),current?.[base]].filter(Boolean));
        if(distinct.size<2){missing=[base];question=prompt;break;}
      } else if(!fields.some(has)){missing=[fields[0]];question=prompt;break;}
    }
    return {...task,state:question?'blocked':resolveTaskCapability(task.intent),missing_slots:missing,
      block_reason:question?'missing_information':null,action_id:null,tool_call:null,_question:question};
  });
  const blocked=tasks.find(task=>task.state==='blocked');
  const clarification={required:Boolean(blocked),kind:blocked?'missing_information':null,
    detail:blocked?(blocked.intent==='need_clarification'?'ambiguous_intent':'missing_required_slot'):null,
    blocking_task_id:blocked?.task_id || null,missing_slots:blocked?.missing_slots || [],question:blocked?._question || null};
  for(const task of tasks)delete task._question;
  const states=tasks.map(t=>t.state);
  const status=states.every(s=>s==='blocked')?'awaiting_clarification':states.every(s=>s==='refused')?'refused':blocked||states.includes('refused')?'partial':'ready';
  return {...recognition,tasks,clarification,status};
}
