// public/components/PlatformUsageDashboard.js
const React = window.React;
const { useState, useEffect } = React;

const PlatformUsageDashboard = () => {
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUsageStats();
    const interval = setInterval(fetchUsageStats, 30000); // Update every 30 seconds
    return () => clearInterval(interval);
  }, []);

  const fetchUsageStats = async () => {
    try {
      const response = await fetch('/api/rate-limits');
      const data = await response.json();
      setUsage(data);
      setLoading(false);
    } catch (error) {
      console.error('Failed to fetch usage stats:', error);
      setLoading(false);
    }
  };

  if (loading) {
    return React.createElement('div', { className: "p-4" }, 'Loading usage stats...');
  }

  if (!usage || !usage.stats) {
    return React.createElement('div', { className: "p-4" }, 'No usage data available');
  }

  const getPlatformIcon = (platform) => {
    const icons = {
      twitter: '𝕏',
      reddit: '🤖',
      linkedin: '💼'
    };
    return icons[platform] || '📱';
  };

  const getUsageColor = (used, limit) => {
    const percentage = (used / limit) * 100;
    if (percentage >= 90) return 'text-red-500';
    if (percentage >= 70) return 'text-yellow-500';
    return 'text-green-500';
  };

  const getProgressBarColor = (used, limit) => {
    const percentage = (used / limit) * 100;
    if (percentage >= 90) return 'bg-red-500';
    if (percentage >= 70) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  return React.createElement('div', { 
    className: "max-w-4xl mx-auto p-6 bg-gray-900 rounded-lg shadow-lg" 
  }, [
    React.createElement('h2', { 
      className: "text-2xl font-bold text-white mb-6" 
    }, '📊 Platform Usage Dashboard'),
    
    React.createElement('div', { 
      className: "grid grid-cols-1 md:grid-cols-3 gap-6 mb-6" 
    }, 
      Object.entries(usage.stats).map(([platform, stats]) => 
        React.createElement('div', { 
          key: platform, 
          className: "bg-gray-800 p-4 rounded-lg" 
        }, [
          React.createElement('div', { 
            className: "flex items-center justify-between mb-3" 
          }, [
            React.createElement('h3', { 
              className: "text-lg font-semibold text-white capitalize flex items-center" 
            }, [
              React.createElement('span', { 
                className: "text-2xl mr-2" 
              }, getPlatformIcon(platform)),
              platform
            ]),
            platform === 'reddit' && React.createElement('span', { 
              className: "text-xs bg-green-600 text-white px-2 py-1 rounded" 
            }, 'PRIORITY')
          ]),
          
          // Daily Usage
          React.createElement('div', { className: "mb-4" }, [
            React.createElement('div', { 
              className: "flex justify-between text-sm text-gray-400 mb-1" 
            }, [
              React.createElement('span', null, 'Daily'),
              React.createElement('span', { 
                className: getUsageColor(stats.daily.used, stats.daily.limit) 
              }, `${stats.daily.used}/${stats.daily.limit}`)
            ]),
            React.createElement('div', { 
              className: "w-full bg-gray-700 rounded-full h-2" 
            }, 
              React.createElement('div', { 
                className: `h-2 rounded-full transition-all ${getProgressBarColor(stats.daily.used, stats.daily.limit)}`,
                style: { width: `${Math.min((stats.daily.used / stats.daily.limit) * 100, 100)}%` }
              })
            )
          ]),
          
          // Monthly Usage (Twitter only)
          stats.monthly && React.createElement('div', null, [
            React.createElement('div', { 
              className: "flex justify-between text-sm text-gray-400 mb-1" 
            }, [
              React.createElement('span', null, 'Monthly'),
              React.createElement('span', { 
                className: getUsageColor(stats.monthly.used, stats.monthly.limit) 
              }, `${stats.monthly.used}/${stats.monthly.limit}`)
            ]),
            React.createElement('div', { 
              className: "w-full bg-gray-700 rounded-full h-2" 
            }, 
              React.createElement('div', { 
                className: `h-2 rounded-full transition-all ${getProgressBarColor(stats.monthly.used, stats.monthly.limit)}`,
                style: { width: `${Math.min((stats.monthly.used / stats.monthly.limit) * 100, 100)}%` }
              })
            )
          ]),
          
          // Platform Status
          React.createElement('div', { 
            className: "mt-3 text-xs text-gray-500" 
          }, 
            stats.daily.remaining === 0 
              ? React.createElement('span', { className: "text-red-400" }, 'Rate limit reached')
              : React.createElement('span', { className: "text-green-400" }, `${stats.daily.remaining} posts remaining today`)
          )
        ])
      )
    ),
    
    // Recommendations
    usage.recommendations && usage.recommendations.length > 0 && React.createElement('div', { 
      className: "bg-gray-800 p-4 rounded-lg mb-4" 
    }, [
      React.createElement('h3', { 
        className: "text-lg font-semibold text-white mb-3" 
      }, '💡 Recommendations'),
      React.createElement('ul', { className: "space-y-2" }, 
        usage.recommendations.map((rec, index) => 
          React.createElement('li', { 
            key: index, 
            className: "text-sm text-gray-300 flex items-start" 
          }, [
            React.createElement('span', { className: "mr-2" }, '•'),
            React.createElement('span', null, rec)
          ])
        )
      )
    ]),
    
    // Reset Times
    React.createElement('div', { className: "bg-gray-800 p-4 rounded-lg" }, [
      React.createElement('h3', { 
        className: "text-lg font-semibold text-white mb-3" 
      }, '⏰ Reset Times'),
      React.createElement('div', { className: "grid grid-cols-2 gap-4 text-sm" }, [
        React.createElement('div', null, [
          React.createElement('span', { className: "text-gray-400" }, 'Daily Reset:'),
          React.createElement('span', { className: "text-white ml-2" }, 
            new Date(usage.nextResets.daily).toLocaleString()
          )
        ]),
        React.createElement('div', null, [
          React.createElement('span', { className: "text-gray-400" }, 'Monthly Reset:'),
          React.createElement('span', { className: "text-white ml-2" }, 
            new Date(usage.nextResets.monthly).toLocaleDateString()
          )
        ])
      ])
    ]),
    
    // Platform Strategy
    React.createElement('div', { 
      className: "mt-6 text-center text-sm text-gray-400" 
    }, [
      React.createElement('p', null, 'Strategy: Prioritize Reddit (50/day) → LinkedIn (10/day) → Twitter (2/day)'),
      React.createElement('p', { className: "mt-1" }, 'Focus: 24/7 Breaking News Coverage 🚨')
    ])
  ]);
};

window.PlatformUsageDashboard = PlatformUsageDashboard;