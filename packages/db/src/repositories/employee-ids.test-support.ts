// Test nurses need a unique employeeId; a counter cannot collide the way six random digits
// occasionally did, and it makes a failing run reproducible.
let counter = 0;

export function nextEmployeeId(): string {
  counter += 1;
  return `E${String(counter).padStart(4, '0')}`;
}
