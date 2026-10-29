export function composeIntentReply({answers=[],refusals=[],clarification=null}={}) {
  const lines=[...refusals,...answers.map(answer=>String(answer?.message || '').trim()).filter(Boolean)];
  if(clarification?.required && clarification.question)lines.push(clarification.question);
  return {
    message:lines.join('\n').trim(),
    next_questions:clarification?.required ? [clarification.question] : [],
    citations:answers.flatMap(answer=>answer?.citations || []),
    recommended_actions:answers.flatMap(answer=>answer?.recommended_actions || [])
  };
}
