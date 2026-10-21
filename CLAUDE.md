# Outpost

Application React + Vite (TypeScript), avec Supabase pour la base, l'authentification et les Edge Functions (`supabase/functions/`).

## Site en ligne

**https://mvggcf5azrvtt7bzmhazitzg.57.129.154.4.sslip.io**

Pas encore de nom de domaine : l'adresse est le sous-domaine sslip.io généré par Coolify.

## Hébergement

Le site tourne sur le VPS OVH `57.129.154.4`, dans Coolify, avec Traefik devant (HTTPS par Let's Encrypt).

| | |
|---|---|
| Coolify | `http://57.129.154.4:8000`, application `app-outpost` |
| UUID de l'application | `mvggcf5azrvtt7bzmhazitzg` |
| Dépôt suivi | `Zombifix/Outpost` (ancien nom `App-Outpost`, redirigé par GitHub), branche `main` |
| Image | construite depuis `Dockerfile` : build Vite sous Node 22, puis service par nginx (`nginx.conf`) sur le port 80 |
| Variables de build | `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY`, définies dans Coolify et passées en `--build-arg` |

L'ancien projet Railway n'existe plus ; `railway.toml` n'est plus utilisé.

## Mettre en production

1. Commit, puis push sur `main`.
2. Coolify a le déploiement automatique activé, mais le webhook n'est pas fiable : lancer le déploiement par l'API. Le jeton est dans `~/.coolify-token`, hors du dépôt (ne jamais l'afficher ni le committer) :

   ```bash
   curl -s -X POST -H "Authorization: Bearer $(cat ~/.coolify-token)" "http://57.129.154.4:8000/api/v1/deploy?uuid=mvggcf5azrvtt7bzmhazitzg&force=false"
   ```

3. Le build prend une à deux minutes. Vérifier ensuite que le site répond avec la nouvelle version. Les logs de déploiement sont dans Coolify.

Si l'API répond 401, le jeton a été changé : en demander un nouveau.

## Développement local

```bash
npm run dev
```

Copier `.env.local.example` en `.env.local` et y mettre les clés Supabase.
