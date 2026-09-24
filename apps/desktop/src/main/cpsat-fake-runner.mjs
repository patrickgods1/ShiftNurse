// A stand-in for native/cpsat-runner that speaks the same JSON-lines protocol, for
// cpsat-process.test.ts. What it does with a request is chosen by `model.fake`.
import { createInterface } from 'node:readline';

const base = {
  id: '',
  version: '',
  objective: 0,
  bound: 0,
  wall_ms: '0',
  status: 'UNKNOWN',
  values: [],
  message: '',
};
const emit = (event) => process.stdout.write(`${JSON.stringify({ ...base, ...event })}\n`);
let waiting;

emit({ type: 'ready', version: 'fake-1' });
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.stop) {
    if (waiting) {
      emit({
        type: 'result',
        id: waiting,
        status: 'FEASIBLE',
        objective: 7,
        bound: 5,
        values: ['1'],
      });
      waiting = undefined;
    }
    return;
  }
  const { id } = request;
  switch (request.model.fake) {
    case 'optimal':
      emit({ type: 'progress', id, objective: 12, bound: 3, wall_ms: '4' });
      emit({
        type: 'result',
        id,
        status: 'OPTIMAL',
        objective: 9,
        bound: 9,
        wall_ms: '10',
        values: ['1', '0', '3'],
      });
      break;
    case 'error':
      emit({ type: 'error', id, message: 'model invalid' });
      break;
    case 'unparseable':
      emit({ type: 'error', id: '', message: 'bad request: expected {' });
      break;
    case 'crash':
      process.stderr.write('boom: segfault in the solver\n');
      process.exit(3);
      break;
    case 'slow':
      emit({ type: 'progress', id, objective: 7, bound: 5, wall_ms: '1' });
      waiting = id;
      break;
  }
});
