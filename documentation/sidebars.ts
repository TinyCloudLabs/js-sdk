import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */
const sidebars: SidebarsConfig = {
  // By default, Docusaurus generates a sidebar from the docs folder structure
  mainSidebar: [
    {
      type: 'doc',
      label: 'Introduction',
      id: 'intro',
    },
    {
      type: 'category',
      label: 'Web SDK',
      link: {
        type: 'doc',
        id: 'web-sdk/index',
      },
      items: [
        {
          type: 'category',
          label: 'Guides',
          link: {
            type: 'doc',
            id: 'web-sdk/guides/index',
          },
          items: [
            {
              type: 'doc',
              label: 'Getting Started',
              id: 'web-sdk/guides/getting-started',
            },
            {
              type: 'doc',
              label: 'Working with Storage',
              id: 'web-sdk/guides/storage-guide',
            },
            {
              type: 'doc',
              label: 'Authentication',
              id: 'web-sdk/guides/authentication-guide',
            },
            {
              type: 'doc',
              label: 'OAuth Canonical Key',
              id: 'web-sdk/guides/manage-key-oauth',
            },
          ],
        },
        {
          type: 'category',
          label: 'API Reference',
          link: {
            type: 'doc',
            id: 'web-sdk/api/index',
          },
          items: [
            {
              type: 'doc',
              label: 'TinyCloudStorage',
              id: 'web-sdk/api/tinycloudstorage',
            },
            {
              type: 'doc',
              label: 'UserAuthorization',
              id: 'web-sdk/api/userauthorization',
            },
          ],
        },
      ],
    },
  ],
};

export default sidebars;
