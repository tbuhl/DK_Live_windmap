# For Hugging Face Spaces (SDK: Docker) or any container host. serve.py needs only the standard library.
FROM python:3.12-slim
WORKDIR /app
COPY . .
ENV PORT=7860
EXPOSE 7860
CMD ["python", "serve.py"]
