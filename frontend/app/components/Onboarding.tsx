
'use client';

import React, { useState } from 'react';
import Image from 'next/image';
import { Microphone2, Box, Notification, ArrowLeft2 } from 'iconsax-react';
import wafrivetLogo from '../assets/Green_Black___White_Modern_Creative_Agency_Typography_Logo-removebg-preview.png';

interface OnboardingProps {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');

  const steps = [
    {
      title: 'Welcome to WafriAI',
      description: 'Modernizing veterinary procurement across Africa with 100% genuine supplies.',
      actionText: 'Get Started',
      visual: (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
          <div
            style={{
              position: 'relative',
              width: '160px',
              height: '160px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Image
              src={wafrivetLogo}
              alt="WafriAI Logo"
              fill
              style={{ objectFit: 'contain' }}
              priority
            />
          </div>
        </div>
      )
    },
    {
      title: 'Speak Naturally',
      description: 'Describe your livestock\'s symptoms out loud. Our AI instantly analyzes the issue and recommends the exact treatments you need.',
      actionText: 'Next',
      visual: (
        <div
          style={{
            width: '120px',
            height: '120px',
            borderRadius: '50%',
            background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '2px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
          }}
        >
          <Microphone2 size={56} variant="Bulk" color="var(--color-primary)" />
        </div>
      )
    },
    {
      title: 'Fast & Genuine Delivery',
      description: 'We locate the nearest verified pharmaceutical suppliers to ensure your treatments arrive quickly and are 100% authentic.',
      actionText: 'Next',
      visual: (
        <div
          style={{
            width: '120px',
            height: '120px',
            borderRadius: '24px',
            background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '2px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
            transform: 'rotate(-5deg)',
          }}
        >
          <Box size={56} variant="Bulk" color="var(--color-primary)" />
        </div>
      )
    },
    {
      title: 'Ready to Start?',
      description: 'We need access to your microphone so you can talk to the AI, and the camera so you can show us your animals.',
      actionText: 'Allow Access & Start',
      visual: (
        <div style={{ display: 'flex', gap: '16px' }}>
          <div
            style={{
              width: '80px',
              height: '80px',
              borderRadius: '24px',
              background: 'color-mix(in srgb, var(--color-surface-2) 60%, transparent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '2px solid var(--color-border)',
            }}
          >
            <Microphone2 size={32} variant="Linear" color="var(--color-text)" />
          </div>
          <div
            style={{
              width: '80px',
              height: '80px',
              borderRadius: '24px',
              background: 'color-mix(in srgb, var(--color-surface-2) 60%, transparent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '2px solid var(--color-border)',
            }}
          >
            <Notification size={32} variant="Linear" color="var(--color-text)" />
          </div>
        </div>
      )
    }
  ];

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setDirection('forward');
      setCurrentStep(prev => prev + 1);
    } else {
      onComplete();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setDirection('backward');
      setCurrentStep(prev => prev - 1);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-bg)', // Bone
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'calc(40px + var(--spacing-safe-top)) 24px calc(32px + var(--spacing-safe-bottom))',
        fontFamily: 'var(--font-inter)',
      }}
    >
      {/* ── Progress Indicators ───────────────────────── */}
      <div style={{ display: 'flex', gap: '8px', width: '100%', justifyContent: 'center' }}>
        {steps.map((_, index) => (
          <div
            key={index}
            style={{
              height: '4px',
              flex: 1,
              maxWidth: '40px',
              borderRadius: '2px',
              background: index === currentStep ? 'var(--color-primary)' : 'color-mix(in srgb, var(--color-primary) 20%, transparent)',
              transition: 'background 0.3s ease',
            }}
          />
        ))}
      </div>

      {/* ── Main Content Area (Animated) ──────────────── */}
      <div
        key={currentStep} // Forces re-mount for CSS animation on step change
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          gap: '48px',
          animation: `${direction === 'forward' ? 'slide-in-right' : 'slide-in-left'} 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards`,
          width: '100%',
          maxWidth: '400px',
        }}
      >
        {steps[currentStep].visual}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h1
            style={{
              fontFamily: 'var(--font-fraunces)',
              fontSize: '28px',
              fontWeight: 800,
              color: 'var(--color-text)', // Forest
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            {steps[currentStep].title}
          </h1>
          <p
            style={{
              fontSize: '15px',
              color: 'var(--color-text-muted)',
              lineHeight: 1.6,
              margin: 0,
            }}
          >
            {steps[currentStep].description}
          </p>
        </div>
      </div>

      {/* ── Action Buttons ────────────────────────────── */}
      <div
        style={{
          width: '100%',
          maxWidth: '400px',
          display: 'flex',
          gap: '12px',
        }}
      >
        {currentStep > 0 && (
          <button
            onClick={handleBack}
            style={{
              width: '60px',
              height: '60px',
              background: 'color-mix(in srgb, var(--color-surface-2) 60%, transparent)',
              border: '1px solid var(--color-border)',
              borderRadius: '16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'transform 0.1s, background 0.2s',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
            }}
            onPointerDown={(e) => (e.currentTarget.style.transform = 'scale(0.94)')}
            onPointerUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
            onPointerLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
            aria-label="Previous step"
          >
            <ArrowLeft2 size={24} color="var(--color-text)" />
          </button>
        )}

        <button
          onClick={handleNext}
          style={{
            flex: 1,
            background: 'var(--color-primary)', // Sage
            color: 'var(--color-white)',
            border: 'none',
            borderRadius: '16px',
            padding: '18px 24px',
            fontSize: '16px',
            fontWeight: 700,
            cursor: 'pointer',
            boxShadow: '0 8px 24px color-mix(in srgb, var(--color-primary) 40%, transparent)',
            transition: 'transform 0.1s, background 0.2s',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
          onPointerDown={(e) => (e.currentTarget.style.transform = 'scale(0.97)')}
          onPointerUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          onPointerLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        >
          {steps[currentStep].actionText}
        </button>
      </div>
    </div>
  );
}
