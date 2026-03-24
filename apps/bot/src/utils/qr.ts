import QRCode from 'qrcode';

export async function generateDepositQR(walletAddress: string): Promise<Buffer> {
  return QRCode.toBuffer(walletAddress, {
    type: 'png',
    width: 300,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });
}
