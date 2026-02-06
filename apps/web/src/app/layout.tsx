export const metadata = {
  title: 'FatTips - Solana Discord Tipping Bot',
  description: 'The ultimate Discord bot for Solana tipping and airdrops',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50">
        {children}
      </body>
    </html>
  )
}
