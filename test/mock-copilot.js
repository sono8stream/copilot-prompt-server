#!/usr/bin/env node

const args = process.argv.slice(2);
const promptIndex = args.indexOf('-p');

if (promptIndex >= 0) {
  const promptText = args[promptIndex + 1] || '';
  const matches = [...promptText.matchAll(/User:\s*([\s\S]*?)(?=\n\nUser:|\n\nAssistant:|$)/g)];
  const text = matches.length > 0 ? matches[matches.length - 1][1].trim() : promptText.trim() || 'unknown';
  process.stdout.write('MOCK_STREAM_PART1 ');
  setTimeout(() => {
    process.stdout.write(`MOCK_STREAM_PART2(${text})\n`);
    process.exit(0);
  }, 120);
  return;
}

process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', () => {
  // no-op: chat path should not use stdin interactive mode in tests.
});

setTimeout(() => {
  process.exit(0);
}, 2000);
