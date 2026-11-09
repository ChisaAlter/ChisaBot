// Executed under flock --no-fork. EOF means the owning Host has exited or released ownership.
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
process.stdout.write("locked\n");
