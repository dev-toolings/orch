// Bun 1.4.4's Bun.which(name) ignores a PATH mutated after launch.
export function which(name: string): string | null {
  return Bun.which(name, { PATH: process.env.PATH });
}
