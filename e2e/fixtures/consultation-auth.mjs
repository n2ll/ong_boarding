import { createServer } from "node:http";

// 폐기 가능한 로컬 인증 fixture. 앱의 실제 미들웨어를 그대로 거치며 외부 Supabase는 사용하지 않는다.
createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.method === "GET" && request.url === "/health") {
    response.end("{}");
  } else if (request.method === "GET" && request.url === "/auth/v1/user"
    && request.headers.authorization === "Bearer consultation-fixture") {
    response.end(JSON.stringify({ id: "00000000-0000-4000-8000-000000000007",
      aud: "authenticated", role: "authenticated", email: "consultation@example.test" }));
  } else {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: "unsupported fixture request" }));
  }
}).listen(3179, "127.0.0.1");
