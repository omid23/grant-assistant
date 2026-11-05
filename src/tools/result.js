// What a tool's run() returns. The outcome lands in the audit log; the result goes to the model.
export const ok = (result) => ({ outcome: 'ok', result });
export const refused = (error) => ({ outcome: 'refused', result: { error } });
export const failed = (error) => ({ outcome: 'failed', result: { error } });
