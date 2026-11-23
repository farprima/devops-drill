type Fields = Record<string, unknown>;

function write(stream: NodeJS.WriteStream, level: string, msg: string, fields: Fields): void {
  stream.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })}\n`);
}

/** One JSON object per line, so `docker logs` / journald output stays greppable. */
export const log = {
  info: (msg: string, fields: Fields = {}) => write(process.stdout, "info", msg, fields),
  error: (msg: string, fields: Fields = {}) => write(process.stderr, "error", msg, fields),
};
