FROM python:3.10.13-slim
WORKDIR /opt/research-assistant
COPY requirements.txt ./requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip python -m pip install --timeout 300 --retries 10 torch==2.7.1+cpu --extra-index-url https://download.pytorch.org/whl/cpu

RUN --mount=type=cache,target=/root/.cache/pip python -m pip install --timeout 300 --retries 10 -r requirements.txt
COPY . .
EXPOSE 5000
CMD ["waitress-serve", "--listen=0.0.0.0:5000", "wsgi:application"]
