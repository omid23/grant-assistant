// One JSON object per line on stdout/stderr, so any log shipper can parse it.
// Never pass message text or document content here: logs are not the place for community data.

export function createLogger({ level = 'info', out = process.stdout, err = process.stderr } = {}) {
  const write = (stream, severity, event, fields) => {
    stream.write(JSON.stringify({ at: new Date().toISOString(), level: severity, event, ...fields }) + '\n');
  };
  return {
    info: (event, fields = {}) => { if (level === 'info') write(out, 'info', event, fields); },
    error: (event, fields = {}) => { if (level !== 'silent') write(err, 'error', event, fields); },
  };
}

export const silentLogger = createLogger({ level: 'silent' });
