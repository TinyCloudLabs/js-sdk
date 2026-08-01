import { getProvider } from "../src/providers/utils";
import { RPCProviders } from "../src/providers/types";

describe("getProvider network selection", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      json: async () => ({ result: "0x1" }),
    });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  test.each([
    ["string", "arbitrum", "https://eth-arbitrum.g.alchemy.com/v2/test-key"],
    ["number", 137, "https://eth-polygon-mainnet.g.alchemy.com/v2/test-key"],
    [
      "chainId object",
      { chainId: 137, name: "polygon" },
      "https://eth-polygon-mainnet.g.alchemy.com/v2/test-key",
    ],
  ])("uses the %s Networkish shape", async (_shape, network, expectedUrl) => {
    const rpc = {
      service: RPCProviders.AlchemyProvider,
      apiKey: "test-key",
      network,
    };

    await getProvider(rpc).request({ method: "eth_chainId", params: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      expectedUrl,
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("does not turn an unknown numeric chain into mainnet", async () => {
    const rpc = {
      service: RPCProviders.AlchemyProvider,
      apiKey: "test-key",
      network: 999,
    };

    await getProvider(rpc).request({ method: "eth_chainId", params: [] });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://eth-999.g.alchemy.com/v2/test-key",
    );
  });

  test("does not ignore a network on a generic Cloudflare configuration", async () => {
    const rpc = {
      service: RPCProviders.CloudflareProvider,
      network: 137,
    };

    await getProvider(rpc).request({ method: "eth_chainId", params: [] });

    expect(fetchMock.mock.calls[0][0]).toBe("https://polygon-rpc.com");
  });
});
