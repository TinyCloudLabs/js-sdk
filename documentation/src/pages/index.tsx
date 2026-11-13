import { ReactNode, useState, useEffect } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './index.module.css';

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e) => {
      setMousePosition({
        x: (e.clientX / window.innerWidth) * 2 - 1,
        y: (e.clientY / window.innerHeight) * 2 - 1
      });
    };
    
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      {/* Animated background elements */}
      <div className={styles.heroBackground}>
        {/* Animated gradient orbs */}
        <div 
          className={styles.gradientOrb1}
          style={{
            transform: `translate(${mousePosition.x * 20}px, ${mousePosition.y * 20}px)`,
          }}
        />
        <div 
          className={styles.gradientOrb2}
          style={{
            transform: `translate(${mousePosition.x * -20}px, ${mousePosition.y * -20}px)`,
          }}
        />
        
        {/* Floating particles */}
        <div className={styles.particles}>
          {[...Array(20)].map((_, i) => (
            <div
              key={i}
              className={styles.particle}
              style={{
                left: `${Math.random() * 100}%`,
                top: `${Math.random() * 100}%`,
                animationDelay: `${Math.random() * 5}s`,
              }}
            />
          ))}
        </div>
      </div>

      <div className="container">
        <div className={styles.logoContainer}>
          <div className={styles.logoWrapper}>
            <img 
              src="/img/logoIcon.png" 
              alt="TinyCloud Icon" 
              className={styles.logoIcon}
            />
            <img 
              src="/img/Text-Logo.png" 
              alt="TinyCloud" 
              className={styles.logoText}
            />
          </div>
        </div>
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className={clsx('button button--secondary button--lg', styles.primaryButton)}
            to="/docs/intro">
            Get Started with TinyCloud SDK
          </Link>
        </div>
      </div>
    </header>
  );
}

function Features() {
  const features = [
    {
      title: 'Decentralized Storage',
      icon: '🔐',
      description: (
        <>
          Store and retrieve data securely without relying on centralized servers. 
          TinyCloud provides a simple API for decentralized storage operations.
        </>
      ),
    },
    {
      title: 'Web3 Authentication',
      icon: '🔑',
      description: (
        <>
          Seamlessly integrate wallet-based authentication with Sign-in with Ethereum (SIWE).
          Connect with all major Web3 wallets out of the box.
        </>
      ),
    },
    {
      title: 'Developer-Friendly',
      icon: '👩‍💻',
      description: (
        <>
          Built with TypeScript for comprehensive type safety and intellisense support.
          Simple APIs abstract away the complexities of blockchain interactions.
        </>
      ),
    },
    {
      title: 'Fast Integration',
      icon: '⚡',
      description: (
        <>
          Get up and running quickly with minimal configuration.
          Comprehensive documentation and examples help you integrate in minutes.
        </>
      ),
    },
  ];

  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {features.map(({title, icon, description}, idx) => (
            <div key={idx} className={clsx('col col--3', styles.featureItem)}>
              <div className={styles.featureIcon}>{icon}</div>
              <h3 className={styles.featureTitle}>{title}</h3>
              <p className={styles.featureDescription}>{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ExampleSection() {
  return (
    <section className={styles.exampleSection}>
      <div className="container">
        <div className={styles.exampleContainer}>
          <div className={styles.exampleContent}>
            <h2 className={styles.exampleTitle}>Easy to Integrate</h2>
            <p className={styles.exampleText}>
              Get started with just a few lines of code. TinyCloud SDK is designed to be intuitive
              and easy to integrate into your application.
            </p>
            <Link
              className={clsx('button button--secondary', styles.exampleButton)}
              to="/docs/web-sdk/guides/getting-started">
              View More Examples
            </Link>
          </div>
          <div className={styles.codeExample}>
            <div className={styles.codeExampleHeader}>
              <div className={styles.codeExampleDot} style={{backgroundColor: '#ff5f56'}}></div>
              <div className={styles.codeExampleDot} style={{backgroundColor: '#ffbd2e'}}></div>
              <div className={styles.codeExampleDot} style={{backgroundColor: '#27c93f'}}></div>
              <div className={styles.codeExampleTitle}>Example.tsx</div>
            </div>
            <div className={styles.codeContent}>
              {/* Using BrowserOnly since syntax highlighting needs the DOM */}
              <pre className="prism-code language-typescript" style={{color: '#FDF9D2', background: 'transparent'}}>
                <code className="language-typescript">
                  <span className="token comment" style={{color: '#7d8799'}}>// Install the SDK</span><br/>
                  <span className="token" style={{color: '#FDF9D2'}}>npm install </span>
                  <span className="token string" style={{color: '#a5d6ff'}}>@tinycloud/web-sdk</span><br/><br/>
                  
                  <span className="token comment" style={{color: '#7d8799'}}>// Import and initialize</span><br/>
                  <span className="token keyword" style={{color: '#ff7b72'}}>import</span>
                  <span className="token" style={{color: '#FDF9D2'}}> {'{ '}</span>
                  <span className="token" style={{color: '#7DB0D2'}}>TinyCloudWeb</span>
                  <span className="token" style={{color: '#FDF9D2'}}> {'}'} </span>
                  <span className="token keyword" style={{color: '#ff7b72'}}>from</span>
                  <span className="token" style={{color: '#FDF9D2'}}> </span>
                  <span className="token string" style={{color: '#a5d6ff'}}>'@tinycloud/web-sdk'</span>
                  <span className="token" style={{color: '#FDF9D2'}}>;</span><br/><br/>
                  
                  <span className="token keyword" style={{color: '#ff7b72'}}>const</span>
                  <span className="token" style={{color: '#FDF9D2'}}> tc = </span>
                  <span className="token keyword" style={{color: '#ff7b72'}}>new</span>
                  <span className="token" style={{color: '#FDF9D2'}}> </span>
                  <span className="token class-name" style={{color: '#7DB0D2'}}>TinyCloudWeb</span>
                  <span className="token" style={{color: '#FDF9D2'}}>{'();'}</span><br/>
                  
                  <span className="token comment" style={{color: '#7d8799'}}>// Connect to wallet</span><br/>
                  <span className="token keyword" style={{color: '#ff7b72'}}>await</span>
                  <span className="token" style={{color: '#FDF9D2'}}> tc.connect();</span><br/><br/>
                  
                  <span className="token comment" style={{color: '#7d8799'}}>// Use decentralized storage</span><br/>
                  <span className="token keyword" style={{color: '#ff7b72'}}>const</span>
                  <span className="token" style={{color: '#FDF9D2'}}> storage = tc.storage;</span><br/>
                  <span className="token keyword" style={{color: '#ff7b72'}}>await</span>
                  <span className="token" style={{color: '#FDF9D2'}}> storage.put(</span>
                  <span className="token string" style={{color: '#a5d6ff'}}>'myKey'</span>
                  <span className="token" style={{color: '#FDF9D2'}}>, {'{ '}</span>
                  <span className="token" style={{color: '#7DB0D2'}}>hello</span>
                  <span className="token" style={{color: '#FDF9D2'}}>: </span>
                  <span className="token string" style={{color: '#a5d6ff'}}>'world'</span>
                  <span className="token" style={{color: '#FDF9D2'}}> {'}'});</span><br/>
                  <span className="token keyword" style={{color: '#ff7b72'}}>const</span>
                  <span className="token" style={{color: '#FDF9D2'}}> result = </span>
                  <span className="token keyword" style={{color: '#ff7b72'}}>await</span>
                  <span className="token" style={{color: '#FDF9D2'}}> storage.get(</span>
                  <span className="token string" style={{color: '#a5d6ff'}}>'myKey'</span>
                  <span className="token" style={{color: '#FDF9D2'}}>);</span><br/>
                  <span className="token" style={{color: '#FDF9D2'}}>console.log(result.data);</span>
                  <span className="token comment" style={{color: '#7d8799'}}> // {`{ hello: 'world' }`}</span>
                </code>
              </pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function CoreValues() {
  const values = [
    { 
      title: "Sovereignty", 
      icon: "🔒",
      desc: "You approve capability-based scopes for application access to your data."
    },
    { 
      title: "Privacy", 
      icon: "🛡️",
      desc: "Ordinary hosted data is plaintext at rest. Capability-based access does not provide general stored-data end-to-end encryption or remove trust in the host."
    },
    { 
      title: "Interoperability", 
      icon: "🔄",
      desc: "Embracing artifact-based formats like Markdown, JSON Canvas, CSV, and SQLite so that data remains portable and future-proof." 
    },
    { 
      title: "Open Innovation", 
      icon: "✨",
      desc: "We view AI's rapid growth as an opportunity to endow individuals with new capabilities—before these capabilities are seized exclusively by large institutions." 
    }
  ];

  return (
    <section className={styles.valuesSection}>
      <div className="container">
        <h2 className={styles.valuesSectionTitle}>Core Values</h2>
        <div className={styles.valuesGrid}>
          {values.map(({title, icon, desc}, idx) => (
            <div key={idx} className={styles.valueCard}>
              <div className={styles.valueIcon}>{icon}</div>
              <h3 className={styles.valueTitle}>{title}</h3>
              <p className={styles.valueDescription}>{desc}</p>
            </div>
          ))}
        </div>
        <p className={styles.valueDescription}>
          <a href="https://docs.tinycloud.xyz/concepts/security-and-trust">Security and trust: storage, key management, and access boundaries</a>
        </p>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} - Web3 Development Tools`}
      description="TinyCloud SDK provides decentralized storage, authentication, and Web3 capabilities for modern web applications">
      <HomepageHeader />
      <main>
        <Features />
        <ExampleSection />
        <CoreValues />
      </main>
    </Layout>
  );
}
