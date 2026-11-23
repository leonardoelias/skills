#!/usr/bin/env node
// Entry point for agents and humans. It has no dependencies: it needs only Node 20.10+, gh and git.
import { main } from '../src/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
