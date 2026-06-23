FROM quay.io/keycloak/keycloak:26.2

# Pre-build Keycloak with the postgres provider so `start --optimized` works.
# This bakes the DB driver into the image at build time, cutting startup by ~30s.
RUN /opt/keycloak/bin/kc.sh build \
      --db=postgres \
      --health-enabled=true

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
