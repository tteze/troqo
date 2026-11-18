// PM2 — production sur le VPS (utilisateur deploy). Copié dans /var/www/troqo/ à chaque déploiement ;
// le serveur tourne depuis /var/www/troqo/current (lien vers la release active).
// Les variables viennent de /var/www/troqo/.env (jamais versionné) : TROQO_ADMIN_TOKEN au minimum.
// Port 3200 : 3000, 3100, 3101 et 4000 sont pris par les autres projets du même VPS.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = __dirname;

/** Lit un fichier .env simple (CLE=valeur, guillemets optionnels). */
function readEnv(file) {
  const env = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

module.exports = {
  apps: [
    {
      name: 'troqo-server',
      cwd: join(root, 'current'),
      script: 'dist/cli.js',
      args: 'server',
      node_args: '--disable-warning=ExperimentalWarning',
      env: {
        TROQO_DB: join(root, 'data/troqo.db'),
        ...readEnv(join(root, '.env')),
        NODE_ENV: 'production',
        TROQO_HOST: '127.0.0.1',
        TROQO_PORT: '3200',
        // Derrière Apache : limites de débit par adresse du client (dernière entrée de X-Forwarded-For).
        TROQO_TRUST_PROXY: '1',
      },
      // Une seule instance : anti-rejeu et limites de débit en mémoire, SQLite.
      instances: 1,
      exec_mode: 'fork',
      kill_timeout: 10000,
      max_memory_restart: '300M',
      time: true,
    },
  ],
};
