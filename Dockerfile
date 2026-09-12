# Étape 1 : compilation
FROM node:22-alpine AS build
WORKDIR /app

# Les dépendances d'abord : cette couche est réutilisée tant que
# package.json / package-lock.json ne changent pas.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite remplace ces valeurs dans le bundle au moment du build.
# Coolify les transmet automatiquement en --build-arg.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

RUN npm run build

# Étape 2 : service des fichiers statiques
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
