#!/bin/bash
cd /home/sensei/girls-in-sports
npx tsx src/scripts/worker.ts > /tmp/worker-combined.log 2>&1
