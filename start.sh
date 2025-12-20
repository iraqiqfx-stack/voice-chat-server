#!/bin/sh
echo "Running database migration..."
node migrate.js
echo "Starting server..."
node server.js
