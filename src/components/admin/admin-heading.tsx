// Section title and one line of description. On a phone the section bar already
// names the section, so the title is only read aloud there.
export function AdminHeading({ title, description }: { title: string; description: string }) {
  return (
    <header className="mb-4 space-y-1">
      <h1 className="text-lg font-semibold max-md:sr-only">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </header>
  );
}
