import { Workspace } from './workspace'

export default function Home() {
  const clerkKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL

  if (!clerkKey || !convexUrl) {
    return <main className="shell"><div className="notice">
      <h1>LendLoop</h1>
      <p>Set the Clerk publishable key and the Convex URL to start the tool library.</p>
    </div></main>
  }

  return <Workspace clerkKey={clerkKey} convexUrl={convexUrl} />
}
