FROM kong:3.5-ubuntu

USER root

# Install Node.js 20 LTS via NodeSource
RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install the kong-pdk plugin server globally (package was renamed from kong-js-pdk)
# Binary is kong-js-pluginserver
RUN npm install -g kong-pdk

# Copy and install the OIDC plugin and its npm dependencies
COPY plugins/oidc /usr/local/kong/plugins/oidc
RUN cd /usr/local/kong/plugins/oidc && npm install --production

USER kong
