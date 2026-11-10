# Linux verification image: Ubuntu 24.04 LTS with its stock Node.js (18.x) and Asterisk 20.
#   docker build -f test/linux/Dockerfile -t labphone-linux-test .
#   docker run --rm labphone-linux-test
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs openssl dpkg-dev asterisk ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . /src
RUN chmod +x bin/labphone.js linux/*.sh test/linux/run.sh test/interop/asterisk/setup.sh
CMD ["bash", "test/linux/run.sh"]
