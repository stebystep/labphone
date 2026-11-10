FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends asterisk openssl \
 && rm -rf /var/lib/apt/lists/*
COPY pjsip.conf.tmpl extensions.conf modules.conf rtp.conf entrypoint.sh /lab/
RUN chmod +x /lab/entrypoint.sh
ENTRYPOINT ["/lab/entrypoint.sh"]
