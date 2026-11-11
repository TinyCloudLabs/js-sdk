import { ServiceContext } from "@tinycloud/sdk-services/context";

const worker = self as unknown as {
  onmessage: (event: MessageEvent<string>) => void;
  postMessage(message: string): void;
};

worker.onmessage = ({ data: host }) => {
  const context = new ServiceContext({
    hosts: [host],
    invoke: () => ({}),
    priority: "background",
  });
  void context.fetch(`${host}/background`).then((response) => response.text()).then(
    () => worker.postMessage("done"),
    (error: Error) => worker.postMessage(error.message),
  );
};
