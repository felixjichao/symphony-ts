#!/usr/bin/env node
/** symctl 入口。 */
import { main } from "./index.js";

const out = main(process.argv.slice(2));
process.stdout.write(out);
if (out.endsWith("\n") === false) process.stdout.write("\n");