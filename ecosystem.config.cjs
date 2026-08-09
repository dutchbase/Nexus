module.exports = {
  apps: [
    {
      name: 'dcc-web',
      cwd: __dirname,
      script: 'bash',
      args: ['-c', 'set -a; source .env; set +a; exec env -u GITHUB_TOKEN NODE_ENV=production DCC_PROCESS_ROLE=web pnpm --filter web dev'],
      autorestart: true,
    },
    {
      name: 'dcc-worker',
      cwd: __dirname,
      script: 'bash',
      args: ['-c', 'set -a; source .env; source .env.worker; set +a; exec env NODE_ENV=production DCC_PROCESS_ROLE=worker pnpm --filter worker start'],
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
