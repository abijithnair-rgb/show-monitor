import './globals.css';
import ChatBot from '@/components/ChatBot';

export const metadata = {
  title: 'Seekho Show Intelligence',
  description: 'Lifecycle verdict × fatigue diagnosis — reconciled into one call per show.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ChatBot />
      </body>
    </html>
  );
}
