const { ethers } = require('ethers');
const { generateTestingUtils } = require('eth-testing');
const { TextEncoder: TE, TextDecoder: TD } = require('util');

jest.mock('axios');

global.TextEncoder = TE;
global.TextDecoder = TD;

const { TinyCloudWeb } = require('../src');

test('Instantiate TinyCloudWeb with window.ethereum', () => {
  expect(() => {
    const tcw = new TinyCloudWeb();
  }).not.toThrowError();
});

test('Instantiate TinyCloudWeb with providers.web3.driver and successfully sign in and sign out', async () => {
  const testingUtils = generateTestingUtils({ providerType: 'MetaMask' });
  testingUtils.mockChainId('0x5');
  testingUtils.mockConnectedWallet([
    '0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1',
  ]);
  const config = {
    providers: {
      web3: {
        driver: new ethers.providers.Web3Provider(testingUtils.getProvider()),
      },
    },
  };
  const tcw = new TinyCloudWeb(config);
  await expect(tcw.signIn({ nonce: 'web-call-nonce' })).resolves.not.toThrowError();
  await expect(tcw.signOut()).resolves.not.toThrowError();
});

test('Instantiate TinyCloudWeb with providers.web3.driver and daoLogin', async () => {
  const testingUtils = generateTestingUtils({ providerType: 'MetaMask' });
  testingUtils.mockChainId('0x1');
  testingUtils.mockConnectedWallet([
    '0x456c1182DecC365DCFb5F981dCaef671C539AD44',
  ]);
  const abi = [
    'event SetDelegate(address indexed delegator, bytes32 indexed id, address indexed delegate)',
    'event ClearDelegate(address indexed delegator, bytes32 indexed id, address indexed delegate)',
  ] as const;
  const contractTestingUtils = testingUtils.generateContractUtils(abi);
  contractTestingUtils.mockGetLogs('SetDelegate', []);
  contractTestingUtils.mockGetLogs('ClearDelegate', []);
  const config = {
    providers: {
      web3: {
        driver: new ethers.providers.Web3Provider(testingUtils.getProvider()),
      },
    },
    enableDaoLogin: true,
  };
  const tcw = new TinyCloudWeb(config);
  await expect(tcw.signIn()).resolves.not.toThrowError();
});

test('Instantiate TinyCloudWeb with providers.web3.driver and server and successfully sign in and sign out', async () => {
  const testingUtils = generateTestingUtils({ providerType: 'MetaMask' });
  testingUtils.mockChainId('0x5');
  testingUtils.mockConnectedWallet([
    '0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1',
  ]);
  const config = {
    providers: {
      web3: {
        driver: new ethers.providers.Web3Provider(testingUtils.getProvider()),
      },
      server: {
        host: 'http://localhost:3001',
      },
    },
  };
  const tcw = new TinyCloudWeb(config);

  const mockAxios = jest.requireMock('axios');
  mockAxios.default.create = jest.fn().mockImplementation(() => ({
    request: async (props: { url: string }) => {
      switch (props.url) {
        case '/tcw-nonce':
          return { data: 'ZH54GNgkQWB887iJU' };
        default:
          return { data: {} };
      }
    },
  }));

  await expect(tcw.signIn()).resolves.not.toThrowError();
  await expect(tcw.signOut()).resolves.not.toThrowError();
});

test('Should override paths successfully', async () => {
  expect(() => {
    const tcw = new TinyCloudWeb({
      providers: {
        server: {
          host: 'http://localhost:3001',
          endpoints: {
            nonce: '/tcw-custom-nonce',
            login: '/tcw-custom-login',
            logout: '/tcw-custom-logout',
          },
        },
      },
    });
  }).not.toThrowError();
});

test('Should override paths with TCWRouteConfig successfully', async () => {
  expect(() => {
    const tcw = new TinyCloudWeb({
      providers: {
        server: {
          host: 'http://localhost:3001',
          endpoints: {
            nonce: { url: '/tcw-custom-nonce', method: 'post' },
            login: { url: '/tcw-custom-login', method: 'post' },
            logout: { url: '/tcw-custom-logout', method: 'post' },
          },
        },
      },
    });
  }).not.toThrowError();
});

test('Should accept axios request config options successfully', async () => {
  expect(() => {
    const tcw = new TinyCloudWeb({
      providers: {
        server: {
          host: 'http://localhost:3001',
          endpoints: {
            nonce: {
              url: '/tcw-custom-nonce',
              method: 'post',
              headers: { 'X-Requested-With': 'XMLHttpRequest' },
              transformRequest: [
                function (data, headers) {
                  // Do whatever you want to transform the data
                  console.log('Test: transformRequest', data, headers);
                  return data;
                },
              ],
            },
          },
        },
      },
    });
  }).not.toThrowError();
});
