module.exports = {
  apps: [
    {
      name: 'dcc-web',
      cwd: __dirname,
      script: 'bash',
      args: ['-c', 'set -a; source .env; set +a; exec pnpm --filter web dev'],
      autorestart: true,
    },
    {
      name: 'dcc-worker',
      cwd: __dirname,
      script: 'bash',
      args: ['-c', 'set -a; source .env; set +a; exec pnpm --filter worker start'],
      autorestart: true,
    },
    {
      name: 'dcc-webhook',
      cwd: __dirname,
      script: 'bash',
      args: ['-c', 'set -a; source .env; set +a; exec node webhook-server.js'],
      autorestart: true,
    },
  ],
};
