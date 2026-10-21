#!/usr/bin/env bun
import { main } from "./report.ts";

process.exitCode = main(process.argv.slice(2));
