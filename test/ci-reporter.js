// Pokazuje przyczynę błędu jako adnotację GitHub Actions, bez potrzeby odczytu prywatnych logów.
import path from "node:path";
import process from "node:process";

export default async function* report(source) {
  const escape = (text) => String(text).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const data = event.data;
    const cause = data.details?.error?.cause || data.details?.error;
    const file = path.relative(process.cwd(), data.file || "test/e2e.test.js").replaceAll("\\", "/");
    yield `::error file=${file},line=${data.line || 1}::${escape(data.name + "\n" + (cause?.stack || cause?.message || "Test nie powiódł się"))}\n`;
  }
}
