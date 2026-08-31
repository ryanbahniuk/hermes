// Bun loads files imported with `{ type: "text" }` as their raw string contents.
// This ambient declaration gives those imports a type for `tsc`.
declare module "*.md" {
  const content: string;
  export default content;
}
