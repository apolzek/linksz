// A moment to the second, in local time: "2026-10-20 19:32:05". Apart from
// ui.js so node can test it without a document.

export function stamp(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
