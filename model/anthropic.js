// Optional real model with the same interface as fake.js, for your own curiosity. Not needed for the task.
// Same interface as fake.js. Not needed for the task or the tests.

export async function complete({ system, messages, tools = [] }) {
  const body = {
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    max_tokens: 1024,
    system,
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    messages: toAnthropic(messages),
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const call = data.content.find((c) => c.type === 'tool_use');
  if (call) return { type: 'tool_call', id: call.id, name: call.name, input: call.input };
  return { type: 'text', text: data.content.filter((c) => c.type === 'text').map((c) => c.text).join('') };
}

function toAnthropic(messages) {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'assistant') {
      const t = m.content;
      return t.type === 'tool_call'
        ? { role: 'assistant', content: [{ type: 'tool_use', id: t.id, name: t.name, input: t.input }] }
        : { role: 'assistant', content: [{ type: 'text', text: t.text }] };
    }
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] };
  });
}
