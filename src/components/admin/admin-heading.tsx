import { cn } from "@/lib/utils";

// Section title and one line of description. On a phone the section bar already
// names the section, so the title is only read aloud there. `destructive` draws the
// title red for sections whose actions cannot be undone.
export function AdminHeading({ title, description, destructive = false }: { title: string; description: string; destructive?: boolean }) {
  return (
    <header className="mb-4 space-y-1">
      <h1 className={cn("text-lg font-semibold max-md:sr-only", destructive && "text-destructive")}>{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </header>
  );
}
