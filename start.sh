#!/bin/sh
echo "Running database migration..."
npx prisma db push --accept-data-loss
echo "Starting server..."
node server.js
