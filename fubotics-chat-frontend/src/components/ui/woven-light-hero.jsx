"use client";

import { useEffect, useRef } from "react";
import { motion, useAnimation } from "framer-motion";
import * as THREE from "three";
import "./woven-light-hero.css";

const titleContainerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.045,
      delayChildren: 0.42,
    },
  },
};

const titleCharVariants = {
  hidden: { opacity: 0, y: 42, rotateX: -80 },
  visible: {
    opacity: 1,
    y: 0,
    rotateX: 0,
    transition: {
      type: "spring",
      stiffness: 180,
      damping: 16,
      mass: 0.8,
    },
  },
};

export function WovenLightHero({
  headline = "NexaCore",
  subtitle = "Ask, research, build, and explore in one focused workspace.",
}) {
  const copyControls = useAnimation();

  useEffect(() => {
    const link = document.createElement("link");
    link.href =
      "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Inter:wght@400;500;600&display=swap";
    link.rel = "stylesheet";
    document.head.appendChild(link);

    copyControls.start({
      opacity: 1,
      y: 0,
      transition: { duration: 0.75, ease: [0.2, 0.65, 0.3, 0.9] },
    });

    return () => {
      document.head.removeChild(link);
    };
  }, [copyControls]);

  const words = headline.split(" ");

  return (
    <section className="woven-hero">
      <WovenCanvas />
      <motion.div
        className="woven-hero-aurora woven-hero-aurora-left"
        initial={{ opacity: 0, scale: 0.82 }}
        animate={{
          opacity: [0.16, 0.28, 0.16],
          scale: [0.82, 1, 0.86],
          x: [-20, 12, -12],
          y: [0, -18, 8],
        }}
        transition={{ duration: 8.5, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="woven-hero-aurora woven-hero-aurora-right"
        initial={{ opacity: 0, scale: 0.88 }}
        animate={{
          opacity: [0.1, 0.22, 0.1],
          scale: [0.88, 1.04, 0.92],
          x: [18, -12, 10],
          y: [10, -12, 0],
        }}
        transition={{ duration: 9.2, repeat: Infinity, ease: "easeInOut", delay: 0.3 }}
      />
      <div className="woven-hero-copy">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={copyControls}
          className="woven-hero-kicker"
        >
          Ask. Research. Build.
        </motion.div>
        <motion.h1
          className="woven-hero-title"
          initial="hidden"
          animate="visible"
          variants={titleContainerVariants}
        >
          {words.map((word, wordIndex) => (
            <span key={`${word}-${wordIndex}`} className="woven-hero-word">
              {word.split("").map((char, charIndex) => (
                <motion.span
                  key={`${char}-${charIndex}`}
                  variants={titleCharVariants}
                  style={{ display: "inline-block" }}
                  whileHover={{ y: -3, transition: { duration: 0.18 } }}
                >
                  {char}
                </motion.span>
              ))}
              {wordIndex < words.length - 1 && <span>&nbsp;</span>}
            </span>
          ))}
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 24 }}
          animate={copyControls}
          transition={{ delay: 0.95, duration: 0.8, ease: [0.2, 0.65, 0.3, 0.9] }}
          className="woven-hero-subtitle"
        >
          {subtitle}
        </motion.p>
        <motion.div
          className="woven-hero-line"
          initial={{ opacity: 0, scaleX: 0.35 }}
          animate={{ opacity: 1, scaleX: 1 }}
          transition={{ delay: 1.15, duration: 0.9, ease: [0.2, 0.65, 0.3, 0.9] }}
        />
      </div>
    </section>
  );
}

function WovenCanvas() {
  const mountRef = useRef(null);

  useEffect(() => {
    if (!mountRef.current) return undefined;

    const mountNode = mountRef.current;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 5;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mountNode.appendChild(renderer.domElement);

    const mouse = new THREE.Vector2(0, 0);
    const clock = new THREE.Clock();
    const isDarkMode = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;

    const particleCount = 50000;
    const positions = new Float32Array(particleCount * 3);
    const originalPositions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const velocities = new Float32Array(particleCount * 3);

    const geometry = new THREE.BufferGeometry();
    const torusKnot = new THREE.TorusKnotGeometry(1.5, 0.5, 200, 32);

    for (let i = 0; i < particleCount; i += 1) {
      const vertexIndex = i % torusKnot.attributes.position.count;
      const x = torusKnot.attributes.position.getX(vertexIndex);
      const y = torusKnot.attributes.position.getY(vertexIndex);
      const z = torusKnot.attributes.position.getZ(vertexIndex);

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      originalPositions[i * 3] = x;
      originalPositions[i * 3 + 1] = y;
      originalPositions[i * 3 + 2] = z;

      const color = new THREE.Color();
      color.setHSL(Math.random(), 0.8, isDarkMode ? 0.62 : 0.7);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.02,
      vertexColors: true,
      blending: isDarkMode ? THREE.NormalBlending : THREE.AdditiveBlending,
      transparent: true,
      opacity: isDarkMode ? 1 : 0.8,
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    const currentPos = new THREE.Vector3();
    const originalPos = new THREE.Vector3();
    const velocity = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const returnForce = new THREE.Vector3();
    const mouseWorld = new THREE.Vector3();

    const handleMouseMove = (event) => {
      mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    };

    let frameId = 0;

    const animate = () => {
      frameId = window.requestAnimationFrame(animate);
      const elapsedTime = clock.getElapsedTime();
      mouseWorld.set(mouse.x * 3, mouse.y * 3, 0);

      for (let i = 0; i < particleCount; i += 1) {
        const ix = i * 3;
        const iy = i * 3 + 1;
        const iz = i * 3 + 2;

        currentPos.set(positions[ix], positions[iy], positions[iz]);
        originalPos.set(originalPositions[ix], originalPositions[iy], originalPositions[iz]);
        velocity.set(velocities[ix], velocities[iy], velocities[iz]);

        const dist = currentPos.distanceTo(mouseWorld);
        if (dist < 1.5) {
          const force = (1.5 - dist) * 0.01;
          direction.subVectors(currentPos, mouseWorld).normalize();
          velocity.add(direction.multiplyScalar(force));
        }

        returnForce.subVectors(originalPos, currentPos).multiplyScalar(0.001);
        velocity.add(returnForce);
        velocity.multiplyScalar(0.95);

        positions[ix] += velocity.x;
        positions[iy] += velocity.y;
        positions[iz] += velocity.z;

        velocities[ix] = velocity.x;
        velocities[iy] = velocity.y;
        velocities[iz] = velocity.z;
      }

      geometry.attributes.position.needsUpdate = true;
      points.rotation.y = elapsedTime * 0.05;
      renderer.render(scene, camera);
    };

    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("resize", handleResize);
    animate();

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("mousemove", handleMouseMove);
      torusKnot.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mountNode) {
        mountNode.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div ref={mountRef} className="woven-hero-canvas" aria-hidden="true" />;
}
