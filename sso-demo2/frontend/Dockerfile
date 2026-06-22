# Static single-page frontend on nginx. Self-contained (inline CSS + JS, no
# external assets), so it serves cleanly at any path with no asset rewriting.
# Built twice (Customer Portal / Internal Tools) with different build args.
FROM nginx:1.27-alpine
ARG APP_NAME="App"
ARG APP_TAGLINE="An app"
ARG ACCENT=#2563eb
COPY index.html /usr/share/nginx/html/index.html
# Single-page app: serve index.html for any path that isn't a real file, so the
# OIDC callback path (/cb) and friends still render the page after Kong is done.
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN sed -i \
      -e "s|__APP_NAME__|${APP_NAME}|g" \
      -e "s|__APP_TAGLINE__|${APP_TAGLINE}|g" \
      -e "s|__ACCENT__|${ACCENT}|g" \
      /usr/share/nginx/html/index.html
EXPOSE 80
